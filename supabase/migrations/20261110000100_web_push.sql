-- Phone and desktop alerts (Web Push). Anyone (staff, Head Nurse, HR, payroll, IT) can turn them on
-- for a device on their Profile page, in the browser or in the app installed from the browser.
-- Every in-app notification is then also pushed to that person's devices, so it shows on the lock
-- screen even when the app is closed. The message is encrypted for the device (RFC 8291) and holds
-- only the notification's title and short text, never endorsement content.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) between 80 and 100),
  auth text not null check (length(auth) between 16 and 30),
  device_label text check (device_label is null or length(device_label) <= 80),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failures int not null default 0
);
create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id);

alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_own on public.push_subscriptions for select to authenticated using (profile_id = auth.uid());
grant select on public.push_subscriptions to authenticated;

-- The server's signing key pair (VAPID). The private key is stored encrypted by the API.
create table internal.web_push_keys (
  id boolean primary key default true check (id),
  public_key text not null,
  private_key_ciphertext text not null,
  created_at timestamptz not null default now()
);

-- One row per notification and device still to be pushed.
create table internal.push_queue (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notifications (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (notification_id, subscription_id)
);
create index push_queue_due_idx on internal.push_queue (next_attempt_at);

create function internal.enqueue_push() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into internal.push_queue (notification_id, subscription_id)
  select new.id, s.id from public.push_subscriptions s where s.profile_id = new.recipient_id
  on conflict do nothing;
  return new;
end $$;
create trigger notifications_push after insert on public.notifications for each row execute function internal.enqueue_push();

-- Turn alerts on for this device. A device that was used by someone else moves to the person now signed in.
create function app.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_label text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth, device_label)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, nullif(left(coalesce(p_label, ''), 80), ''))
  on conflict (endpoint) do update set
    profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth,
    device_label = excluded.device_label, failures = 0
  returning id into v_id;
  perform app.audit('profile.push_enabled', 'profile', auth.uid(), app.my_department());
  return v_id;
end $$;

create function app.remove_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and profile_id = auth.uid();
  if found then perform app.audit('profile.push_disabled', 'profile', auth.uid(), app.my_department()); end if;
end $$;

-- "Send a test alert" on the Profile page: an in-app notification for yourself only (no email).
create function app.send_test_push() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  if not exists (select 1 from public.push_subscriptions where profile_id = auth.uid()) then
    perform app.fail('validation', 'Turn on alerts on this device first');
  end if;
  return app.notify(auth.uid(), 'push_test', 'Alerts are on',
    'This is how Silent Handover alerts appear on this device.', '/notifications',
    'push_test:' || gen_random_uuid()::text, null, false);
end $$;

revoke all on internal.web_push_keys, internal.push_queue from public;
revoke all on function internal.enqueue_push() from public;
revoke all on function app.save_push_subscription(text, text, text, text), app.remove_push_subscription(text), app.send_test_push() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on internal.web_push_keys, internal.push_queue from anon, authenticated';
    execute 'revoke all on function app.save_push_subscription(text, text, text, text), app.remove_push_subscription(text), app.send_test_push() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on internal.web_push_keys, internal.push_queue to service_role';
  end if;
end $$;
grant execute on function app.save_push_subscription(text, text, text, text), app.remove_push_subscription(text), app.send_test_push() to authenticated;
