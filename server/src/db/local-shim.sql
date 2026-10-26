-- LOCAL MODE ONLY. Supabase provides these objects itself; this file recreates the minimum
-- needed to run the same migrations and RLS policies on the embedded PostgreSQL (PGlite).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

-- Same contract as Supabase's auth.uid(): the "sub" claim of the request JWT.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')),
    '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Local password store (Supabase Auth replaces this in production).
create schema if not exists local_auth;
revoke all on schema local_auth from public;
create table if not exists local_auth.credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
