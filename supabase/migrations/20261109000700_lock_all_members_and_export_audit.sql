-- Fixes found by the end-to-end run:
-- 1. Locking a period now needs a certified DTR for EVERY member of the pay group. Before, people
--    with no recorded duties in the period were skipped, and payroll then left them out entirely
--    (a salaried person on leave or with no duties still needs a certified DTR and pay).
-- 2. Exporting DTR totals is audited through its own function (the export route could not call
--    app.audit directly, so the export failed).

create or replace function app.lock_period(p_period uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.cutoff_periods;
  v_missing int;
begin
  if not app.has_capability('timekeeper') then perform app.fail('forbidden', 'Only HR timekeeping can lock a period'); end if;
  select * into v_p from public.cutoff_periods where id = p_period for update;
  if not found then perform app.fail('not_found', 'Cutoff period not found'); end if;
  if v_p.state = 'locked' then perform app.fail('invalid_state', 'Already locked'); end if;
  select count(*) into v_missing
  from public.pay_group_members m
  where m.pay_group_id = v_p.pay_group_id
    and not exists (select 1 from public.dtr_versions d where d.profile_id = m.profile_id and d.period_id = p_period and d.state = 'certified');
  if v_missing > 0 then perform app.fail('invalid_state', v_missing || ' DTR(s) in this pay group are not certified yet'); end if;
  update public.cutoff_periods set state = 'locked', locked_by = auth.uid(), locked_at = now() where id = p_period;
  update public.attendance_records r set locked_at = now()
  from public.shifts s, public.pay_group_members m
  where s.id = r.shift_id and m.profile_id = r.profile_id and m.pay_group_id = v_p.pay_group_id
    and s.shift_date between v_p.start_date and v_p.end_date and r.locked_at is null;
  perform app.audit('dtr.period_locked', 'cutoff_period', p_period, null);
  return jsonb_build_object('locked', true);
end $$;

create function app.record_dtr_export(p_period uuid, p_rows int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.has_capability('timekeeper') or app.has_capability('hr_admin') or app.has_capability('payroll_preparer')) then
    perform app.fail('forbidden', 'Not allowed');
  end if;
  perform app.audit('dtr.exported', 'cutoff_period', p_period, null, jsonb_build_object('rows', p_rows));
end $$;
revoke all on function app.record_dtr_export(uuid, int) from public;
grant execute on function app.record_dtr_export(uuid, int) to authenticated;
