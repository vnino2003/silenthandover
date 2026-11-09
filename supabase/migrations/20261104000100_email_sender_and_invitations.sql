-- Email that really sends, set up by the administrator in the app (like the AI key): a Gmail
-- account with an App Password, or a Resend API key. The secret is stored encrypted by the API
-- (AES-256-GCM); this table only holds ciphertext and a short hint, in the internal schema that
-- signed-in users cannot reach.

create table internal.email_sender_config (
  id boolean primary key default true check (id),
  provider text not null default 'none' check (provider in ('none', 'gmail', 'resend')),
  from_name text check (from_name is null or length(from_name) between 1 and 80),
  from_address text check (from_address is null or length(from_address) between 3 and 200),
  secret_ciphertext text,
  secret_hint text check (secret_hint is null or length(secret_hint) <= 8),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

insert into internal.email_sender_config (id) values (true);

-- Account invitations: the administrator creates the account without a password, and the person
-- chooses their own through a one-time link sent by email. Only a SHA-256 hash of the link's
-- token is stored, so a copy of the database cannot be used to take over an account. The same
-- link type resets a forgotten password.
create table internal.invitations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  purpose text not null default 'invite' check (purpose in ('invite', 'reset')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  send_status text check (send_status is null or send_status in ('sent', 'simulated', 'failed')),
  send_error text,
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index invitations_user_idx on internal.invitations (user_id, created_at desc);

revoke all on internal.email_sender_config, internal.invitations from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on internal.email_sender_config, internal.invitations from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on internal.email_sender_config, internal.invitations to service_role';
  end if;
end $$;

-- The invitation and password-reset emails are editable on "Rules and emails" like the others.
-- {{link}} is the personal one-time link; {{expires}} says until when it works.
insert into public.notification_templates (key, subject, body) values
  ('invitation', 'You are invited to {{app_name}}', E'Hello {{recipient_name}},

{{invited_by}} created your {{app_name}} account as {{role}}{{department}}.

Open this link to choose your password and sign in:
{{link}}

The link works once and expires on {{expires}}. If you were not expecting this, you can ignore this email.'),
  ('password_reset', 'Set a new {{app_name}} password', E'Hello {{recipient_name}},

{{invited_by}} sent you a link to set a new password for {{app_name}}.

Open this link to choose your new password:
{{link}}

The link works once and expires on {{expires}}. Your current password keeps working until you choose a new one.')
on conflict (key) do nothing;
