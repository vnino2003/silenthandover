-- Workforce capabilities: scoped permissions on top of the three base roles.
--
-- The base roles (employee, manager, admin) keep driving every existing rule. A capability adds one
-- duty to a person, optionally limited to one department (null = every department):
--   nursing_service   Chief Nurse / Nursing Service: cross-unit approvals, escalations, certifies a
--                     Head Nurse's own DTR
--   timekeeper        HR timekeeping: reconciles attendance and locks cutoff periods
--   hr_admin          HR: attendance and pay policy, compensation settings
--   payroll_preparer  Payroll personnel: prepares payroll runs from locked DTRs
--   finance_approver  Finance: approves and releases payroll (never a run they prepared)
-- The IT administrator grants and revokes capabilities (account administration) but cannot hold
-- one, so IT never gains workforce or financial data through a grant.

create table public.role_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  capability text not null check (capability in ('nursing_service', 'timekeeper', 'hr_admin', 'payroll_preparer', 'finance_approver')),
  department_id uuid references public.departments (id) on delete cascade,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id) on delete set null
);
create unique index role_grants_active_uq on public.role_grants
  (profile_id, capability, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revoked_at is null;
create index role_grants_profile_idx on public.role_grants (profile_id) where revoked_at is null;

alter table public.role_grants enable row level security;
create policy role_grants_read on public.role_grants for select to authenticated
  using (profile_id = auth.uid() or app.is_admin());

-- Does the signed-in person hold this capability for the department (or for all departments)?
create function app.has_capability(p_capability text, p_department uuid default null) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.role_grants g join public.profiles p on p.id = g.profile_id
    where g.profile_id = auth.uid() and p.is_active and g.revoked_at is null and g.capability = p_capability
      and (g.department_id is null or p_department is null or g.department_id = p_department)
  )
$$;

-- Head Nurse of the department, or Nursing Service covering it: may verify and approve the unit's
-- attendance, corrections and overtime (never their own; checked in each function).
create function app.can_supervise_attendance(p_department uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_manager_of(p_department) or app.has_capability('nursing_service', p_department)
$$;

-- Anyone with an HR or payroll duty for the department.
create function app.can_see_workforce_totals(p_department uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_capability('timekeeper', p_department) or app.has_capability('hr_admin', p_department)
      or app.has_capability('payroll_preparer', p_department) or app.has_capability('finance_approver', p_department)
$$;

create function app.admin_grant_capability(p_profile uuid, p_capability text, p_department uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_target public.profiles;
  v_id uuid;
begin
  if not app.is_admin() then perform app.fail('forbidden', 'Only the system administrator manages access'); end if;
  select * into v_target from public.profiles where id = p_profile and is_active;
  if not found then perform app.fail('not_found', 'Account not found'); end if;
  if v_target.role = 'admin' then
    perform app.fail('validation', 'IT administrator accounts cannot hold HR, payroll or finance access. Use a separate account.');
  end if;
  if p_capability = 'nursing_service' and v_target.role <> 'manager' then
    perform app.fail('validation', 'Nursing Service access is for department heads (Chief Nurse or Nursing Service Office).');
  end if;
  insert into public.role_grants (profile_id, capability, department_id, granted_by)
  values (p_profile, p_capability, p_department, auth.uid())
  on conflict (profile_id, capability, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revoked_at is null do nothing
  returning id into v_id;
  if v_id is null then perform app.fail('conflict', 'This access is already granted'); end if;
  perform app.audit('access.granted', 'profile', p_profile, p_department, jsonb_build_object('capability', p_capability));
  perform app.notify(p_profile, 'access_changed', 'New access: ' || replace(p_capability, '_', ' '),
    'The system administrator gave you this access.', '/', 'grant:' || v_id, null, false);
  return v_id;
end $$;

create function app.admin_revoke_capability(p_grant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_g public.role_grants;
begin
  if not app.is_admin() then perform app.fail('forbidden', 'Only the system administrator manages access'); end if;
  update public.role_grants set revoked_at = now(), revoked_by = auth.uid() where id = p_grant and revoked_at is null returning * into v_g;
  if not found then perform app.fail('not_found', 'Access not found'); end if;
  perform app.audit('access.revoked', 'profile', v_g.profile_id, v_g.department_id, jsonb_build_object('capability', v_g.capability));
end $$;

-- HR, payroll, finance and Nursing Service see the names of the people in their scope (the same
-- limited profile columns as everyone else; contact details stay restricted).
create policy profiles_read_workforce on public.profiles for select to authenticated
  using (app.has_capability('timekeeper', department_id) or app.has_capability('hr_admin', department_id)
         or app.has_capability('payroll_preparer', department_id) or app.has_capability('finance_approver', department_id)
         or app.has_capability('nursing_service', department_id));

-- The profile now lists the person's capabilities, so pages can show the right workspaces.
create or replace function app.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone, 'role', p.role,
    'department_id', p.department_id, 'department_name', d.name, 'department_timezone', d.timezone,
    'team_id', p.team_id, 'team_name', t.name, 'pseudonym', p.pseudonym,
    'notify_email', p.notify_email, 'notify_sms', p.notify_sms, 'is_active', p.is_active,
    'photo_version', (select floor(extract(epoch from ph.updated_at))::bigint from public.profile_photos ph where ph.profile_id = p.id),
    'capabilities', coalesce((
      select jsonb_agg(jsonb_build_object('capability', g.capability, 'department_id', g.department_id) order by g.capability)
      from public.role_grants g where g.profile_id = p.id and g.revoked_at is null), '[]'::jsonb),
    'server_now', now())
  from public.profiles p
  left join public.departments d on d.id = p.department_id
  left join public.teams t on t.id = p.team_id
  where p.id = auth.uid()
$$;

revoke all on function app.has_capability(text, uuid), app.can_supervise_attendance(uuid), app.can_see_workforce_totals(uuid),
  app.admin_grant_capability(uuid, text, uuid), app.admin_revoke_capability(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.admin_grant_capability(uuid, text, uuid), app.admin_revoke_capability(uuid) from anon';
  end if;
end $$;
grant execute on function app.has_capability(text, uuid), app.can_supervise_attendance(uuid), app.can_see_workforce_totals(uuid),
  app.admin_grant_capability(uuid, text, uuid), app.admin_revoke_capability(uuid) to authenticated;
grant select on public.role_grants to authenticated;
