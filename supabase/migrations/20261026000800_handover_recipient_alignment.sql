-- Keep handover visibility aligned with the live incoming-shift roster.
-- A delivery is revoked when a worker is removed from that shift; assigning them again
-- creates a fresh, auditable delivery and acknowledgment cycle.

alter table public.handover_deliveries add column revoked_at timestamptz;
alter table public.handover_deliveries drop constraint if exists handover_deliveries_approval_id_recipient_id_key;
create unique index handover_deliveries_active_recipient_uq
  on public.handover_deliveries (approval_id, recipient_id) where revoked_at is null;

drop policy handover_approvals_read on public.handover_approvals;
create policy handover_approvals_read on public.handover_approvals for select to authenticated
  using (exists (
    select 1 from public.shift_reports r
    where r.id = report_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ) or (decision = 'approved' and exists (
    select 1 from public.handover_deliveries d
    where d.approval_id = handover_approvals.id and d.recipient_id = auth.uid() and d.revoked_at is null
  )));

drop policy handover_deliveries_read on public.handover_deliveries;
create policy handover_deliveries_read on public.handover_deliveries for select to authenticated
  using ((recipient_id = auth.uid() and revoked_at is null) or exists (
    select 1 from public.shift_reports r
    where r.id = report_id and (r.employee_id = auth.uid() or app.is_manager_of(r.department_id))
  ));

create or replace function app.deliver_approval(p_approval uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_approval public.handover_approvals;
  v_report public.shift_reports;
  v_next uuid;
  v_next_shift public.shifts;
  v_event uuid;
  v_emp uuid;
  v_delivery uuid;
  v_count int := 0;
begin
  select * into v_approval from public.handover_approvals where id = p_approval and decision = 'approved';
  if not found then return 0; end if;
  select * into v_report from public.shift_reports where id = v_approval.report_id;
  v_next := app.next_shift(v_report.shift_id);
  if v_next is null then return 0; end if;
  select * into v_next_shift from public.shifts where id = v_next;
  select id into v_event from public.automation_events where approval_id = p_approval and kind = 'handover_delivery';

  for v_emp in
    select employee_id from public.shift_assignments
    where shift_id = v_next and removed_at is null and employee_id <> v_report.employee_id
  loop
    v_delivery := null;
    insert into public.handover_deliveries (approval_id, report_id, recipient_id, shift_id)
    values (p_approval, v_report.id, v_emp, v_next)
    on conflict (approval_id, recipient_id) where revoked_at is null do nothing
    returning id into v_delivery;
    if v_delivery is not null then
      v_count := v_count + 1;
      perform app.notify(v_emp, 'handover_delivered', 'Incoming handover awaiting acknowledgment',
        'An approved handover (' || v_report.reference_code || ') is ready for your ' || v_next_shift.label || ' shift.',
        '/handover', 'handover:' || v_delivery, v_event);
    end if;
  end loop;

  if exists (select 1 from public.handover_deliveries where approval_id = p_approval and revoked_at is null) then
    update public.shift_reports set status = 'delivered' where id = v_report.id and status = 'approved';
  end if;
  if v_count > 0 then
    perform app.audit('handover.delivered', 'handover_approval', p_approval, v_report.department_id,
      jsonb_build_object('incoming_shift', v_next, 'recipients', v_count));
  end if;
  return v_count;
end $$;

create or replace function app.unassign_from_shift(p_shift uuid, p_employee uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
begin
  select department_id into v_dept from public.shifts where id = p_shift;
  if v_dept is null then perform app.fail('not_found', 'Shift not found'); end if;
  perform app.require_manager_of(v_dept);
  update public.shift_assignments set removed_at = now(), removed_by = auth.uid()
  where shift_id = p_shift and employee_id = p_employee and removed_at is null;
  if not found then perform app.fail('not_found', 'Assignment not found'); end if;

  update public.handover_deliveries set revoked_at = now()
  where shift_id = p_shift and recipient_id = p_employee and revoked_at is null;

  update public.shift_reports r set status = 'approved'
  where r.status = 'delivered'
    and exists (select 1 from public.handover_deliveries d where d.report_id = r.id and d.shift_id = p_shift)
    and not exists (select 1 from public.handover_deliveries d where d.report_id = r.id and d.revoked_at is null);

  perform app.audit('shift.unassigned', 'shift', p_shift, v_dept, jsonb_build_object('employee', p_employee));
end $$;

