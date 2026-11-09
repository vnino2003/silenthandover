-- The department head (or Nursing Service) certifies DTRs per pay group, so they need to see which
-- of their own unit's staff are in which pay group. Only membership, for staff in their scope.
create function app.supervises_profile(p_profile uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select app.can_supervise_attendance(department_id) from public.profiles where id = p_profile), false)
$$;
revoke all on function app.supervises_profile(uuid) from public;
grant execute on function app.supervises_profile(uuid) to authenticated;

create policy pay_group_members_read_unit on public.pay_group_members for select to authenticated
  using (app.supervises_profile(profile_id));
