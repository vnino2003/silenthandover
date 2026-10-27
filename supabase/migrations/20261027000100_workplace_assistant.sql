-- Only the API writes proposals. Employees confirm the immutable server snapshot by id/version.
create table internal.assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  shift_id uuid references public.shifts(id) on delete cascade,
  base_report_id uuid,
  base_report_updated_at timestamptz,
  state jsonb not null,
  version integer not null default 1,
  engine text not null,
  reply text not null default '',
  ready boolean not null default false,
  expires_at timestamptz not null default now() + interval '24 hours',
  result jsonb,
  created_at timestamptz not null default now()
);
create index on internal.assistant_proposals(employee_id, expires_at);
revoke all on internal.assistant_proposals from public, anon, authenticated;
grant all on internal.assistant_proposals to service_role;

create function app.confirm_assistant(p_id uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v internal.assistant_proposals;
  r public.shift_reports;
  i public.operational_issues;
  v_id uuid;
  v_result jsonb;
  v_status text;
begin
  if app.my_role() is distinct from 'employee' or not exists (
    select 1 from public.profiles where id = auth.uid() and is_active
  ) then perform app.fail('forbidden', 'Only active employees can use the assistant'); end if;
  select * into v from internal.assistant_proposals where id = p_id and employee_id = auth.uid() for update;
  if not found then perform app.fail('not_found', 'Preparation not found'); end if;
  if v.version <> p_version then perform app.fail('conflict', 'This preparation changed. Review the latest summary.'); end if;
  -- A retry after a lost response returns the original receipt, even after expiration.
  if v.result is not null then return v.result; end if;
  if v.expires_at <= now() then perform app.fail('conflict', 'This preparation expired. Start a new conversation.'); end if;
  if not v.ready then perform app.fail('validation', 'Complete and review the preparation before confirming'); end if;

  case v.state->>'intent'
    when 'report' then
      -- Serialize assistants and regular report creation for the same employee/shift.
      perform pg_advisory_xact_lock(hashtext(auth.uid()::text || v.shift_id::text));
      -- FK inserts from the regular form take a key-share lock on the shift. This
      -- lock also closes the missing-row race with a concurrently created manual draft.
      perform 1 from public.shifts where id = v.shift_id for update;
      select * into r from public.shift_reports where shift_id = v.shift_id and employee_id = auth.uid() for update;
      if (r.id is distinct from v.base_report_id) or
         (r.id is not null and r.updated_at is distinct from v.base_report_updated_at) then
        perform app.fail('conflict', 'The report changed while you were chatting. Start a new preparation to keep the latest edits.');
      end if;
      v_id := app.get_or_create_report(v.shift_id);
      v_result := app.submit_report(v_id, v.state->'content');
      select * into r from public.shift_reports where id = v_id;
      v_result := jsonb_build_object('kind', 'report', 'id', v_id, 'reference', r.reference_code, 'status', r.status);
    when 'incident', 'assistance' then
      v_result := app.raise_issue(v.state->>'title', v.state->>'description', v.state->>'severity', (v.state->>'is_safety')::boolean);
      v_result := v_result || jsonb_build_object('kind', 'issue', 'reference', v_result->>'code');
    when 'task_update' then
      select * into i from public.operational_issues where code = v.state->>'issue_code' and department_id = app.my_department() for update;
      if not found then perform app.fail('not_found', 'Issue not found in your department'); end if;
      if i.status = v.state->>'transition' then
        v_id := app.add_issue_note(i.id, v.state->>'note');
        v_result := jsonb_build_object('id', i.id, 'status', i.status, 'update_id', v_id);
      else
        v_result := app.transition_issue(i.id, v.state->>'transition', v.state->>'note');
      end if;
      v_result := v_result || jsonb_build_object('kind', 'issue', 'id', i.id, 'reference', i.code);
    else perform app.fail('validation', 'This request has no supported action');
  end case;

  update internal.assistant_proposals set result = v_result where id = v.id;
  perform app.audit('assistant.confirmed', 'assistant_proposal', v.id, app.my_department(),
    jsonb_build_object('intent', v.state->>'intent', 'engine', v.engine, 'entity_id', v_result->>'id'));
  return v_result;
end $$;
revoke all on function app.confirm_assistant(uuid, integer) from public, anon;
grant execute on function app.confirm_assistant(uuid, integer) to authenticated;
