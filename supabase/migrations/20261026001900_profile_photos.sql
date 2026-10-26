-- Profile pictures. Everyone (worker, supervisor, administrator) can set or remove their own,
-- and only their own. A picture is visible to whoever can already see that person's profile:
-- themselves, colleagues in the same department, and administrators.

create table public.profile_photos (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size int not null check (byte_size between 1 and 524288),
  data bytea not null,
  updated_at timestamptz not null default now()
);

alter table public.profile_photos enable row level security;
create policy profile_photos_read on public.profile_photos for select to authenticated
  using (
    profile_id = auth.uid() or app.is_admin()
    or exists (select 1 from public.profiles p where p.id = profile_id and p.department_id is not null and p.department_id = app.my_department())
  );
grant select on public.profile_photos to authenticated;

create function app.set_my_photo(p_content_type text, p_base64 text) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_data bytea;
  v_at timestamptz := now();
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    perform app.fail('validation', 'Use a JPEG, PNG or WebP picture');
  end if;
  begin
    v_data := decode(p_base64, 'base64');
  exception when others then
    perform app.fail('validation', 'The picture could not be read');
  end;
  if length(v_data) > 524288 then perform app.fail('validation', 'Pictures must be 512 KB or smaller'); end if;
  -- The bytes must really be the image type claimed, so nothing else can be served as a picture.
  if not ((p_content_type = 'image/jpeg' and substring(v_data from 1 for 3) = '\xffd8ff'::bytea)
       or (p_content_type = 'image/png' and substring(v_data from 1 for 8) = '\x89504e470d0a1a0a'::bytea)
       or (p_content_type = 'image/webp' and substring(v_data from 1 for 4) = '\x52494646'::bytea and substring(v_data from 9 for 4) = '\x57454250'::bytea)) then
    perform app.fail('validation', 'That file is not a picture');
  end if;
  insert into public.profile_photos (profile_id, content_type, byte_size, data, updated_at)
  values (auth.uid(), p_content_type, length(v_data), v_data, v_at)
  on conflict (profile_id) do update set
    content_type = excluded.content_type, byte_size = excluded.byte_size, data = excluded.data, updated_at = excluded.updated_at;
  perform app.audit('profile.photo_updated', 'profile', auth.uid(), app.my_department());
  return v_at;
end $$;

create function app.remove_my_photo() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then perform app.fail('forbidden', 'Sign in first'); end if;
  delete from public.profile_photos where profile_id = auth.uid();
  if found then perform app.audit('profile.photo_removed', 'profile', auth.uid(), app.my_department()); end if;
end $$;

-- The signed-in profile now says whether there is a picture (and its version, for caching).
create or replace function app.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone, 'role', p.role,
    'department_id', p.department_id, 'department_name', d.name, 'department_timezone', d.timezone,
    'team_id', p.team_id, 'team_name', t.name, 'pseudonym', p.pseudonym,
    'notify_email', p.notify_email, 'notify_sms', p.notify_sms, 'is_active', p.is_active,
    'photo_version', (select floor(extract(epoch from ph.updated_at))::bigint from public.profile_photos ph where ph.profile_id = p.id),
    'server_now', now())
  from public.profiles p
  left join public.departments d on d.id = p.department_id
  left join public.teams t on t.id = p.team_id
  where p.id = auth.uid()
$$;

revoke all on function app.set_my_photo(text, text), app.remove_my_photo() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.set_my_photo(text, text), app.remove_my_photo() from anon';
  end if;
end $$;
grant execute on function app.set_my_photo(text, text), app.remove_my_photo() to authenticated;
