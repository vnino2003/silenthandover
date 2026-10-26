-- The administrator chooses the AI provider and pastes its API key on the admin page, so the
-- key is never written into code or configuration files.
-- The key is stored encrypted (AES-256-GCM by the API, with SECRETS_ENCRYPTION_KEY); this table
-- only ever holds ciphertext and the last four characters as a hint. It lives in the
-- internal schema, which signed-in users cannot reach at all: only the API's service
-- connection reads it, and the key is never returned to any browser.

create table internal.ai_provider_config (
  id boolean primary key default true check (id),
  provider text not null default 'simulator' check (provider in ('simulator', 'gemini', 'grok')),
  model text check (model is null or length(model) between 2 and 100),
  api_key_ciphertext text,
  api_key_hint text check (api_key_hint is null or length(api_key_hint) <= 8),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

insert into internal.ai_provider_config (id) values (true);

revoke all on internal.ai_provider_config from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on internal.ai_provider_config from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on internal.ai_provider_config to service_role';
  end if;
end $$;
