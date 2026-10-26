-- Bringing a removed shift pattern back restores its upcoming shifts that removing it had
-- cancelled, instead of leaving them stuck as "Cancelled" on the schedule.

drop function app.sync_pattern_shifts(uuid);

create function app.sync_pattern_shifts(p_template uuid, p_restore boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.shift_templates;
  v_count int;
begin
  select * into v_t from public.shift_templates where id = p_template;
  if not found then perform app.fail('not_found', 'Shift pattern not found'); end if;
  perform app.require_manager_of(v_t.department_id);
  -- A pattern brought back brings back its upcoming shifts that removing it had cancelled.
  if p_restore then
    update public.shifts s set status = 'scheduled'
    where s.template_id = p_template and s.status = 'cancelled' and s.starts_at > now()
      and extract(isodow from s.shift_date)::smallint = any(v_t.weekdays);
  end if;
  with moved as (
    select s.id,
           (s.shift_date + v_t.start_time) at time zone s.timezone as starts_at,
           ((case when v_t.end_time <= v_t.start_time then s.shift_date + 1 else s.shift_date end) + v_t.end_time) at time zone s.timezone as ends_at
    from public.shifts s
    where s.template_id = p_template and s.status = 'scheduled' and s.starts_at > now()
      and not exists (select 1 from public.shift_reports r where r.shift_id = s.id)
  )
  update public.shifts s set
    label = v_t.name,
    starts_at = m.starts_at,
    ends_at = m.ends_at,
    window_opens_at = greatest(m.starts_at, m.ends_at - make_interval(mins => v_t.window_open_minutes)),
    window_closes_at = m.ends_at + make_interval(mins => v_t.grace_minutes),
    allow_early_draft = v_t.allow_early_draft
  from moved m
  where s.id = m.id and m.starts_at > now()
    and (s.label, s.starts_at, s.ends_at) is distinct from (v_t.name, m.starts_at, m.ends_at);
  get diagnostics v_count = row_count;
  -- Days taken off the pattern lose their upcoming shifts.
  update public.shifts s set status = 'cancelled'
  where s.template_id = p_template and s.status = 'scheduled' and s.starts_at > now()
    and not (extract(isodow from s.shift_date)::smallint = any(v_t.weekdays))
    and not exists (select 1 from public.shift_reports r where r.shift_id = s.id);
  if v_count > 0 then
    perform app.audit('shifts.moved', 'shift_template', p_template, v_t.department_id, jsonb_build_object('moved', v_count));
  end if;
  return v_count;
end $$;

revoke all on function app.sync_pattern_shifts(uuid, boolean) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app.sync_pattern_shifts(uuid, boolean) from anon';
  end if;
end $$;
grant execute on function app.sync_pattern_shifts(uuid, boolean) to authenticated;
