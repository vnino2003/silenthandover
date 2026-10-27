-- Save an assistant preparation through the ordinary draft rules, without submitting it.
create function app.save_assistant_draft(p_id uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v internal.assistant_proposals;
  r public.shift_reports;
  v_id uuid;
  receipt jsonb;
begin
  if app.my_role() is distinct from 'employee' or not exists(select 1 from public.profiles where id=auth.uid() and is_active) then
    perform app.fail('forbidden','Only active employees can prepare reports');
  end if;
  select * into v from internal.assistant_proposals where id=p_id and employee_id=auth.uid() for update;
  if not found then perform app.fail('not_found','Preparation not found'); end if;
  if v.version <> p_version then perform app.fail('conflict','This preparation changed. Reload it first.'); end if;
  if v.result is not null then return v.result; end if;
  if v.expires_at <= now() then perform app.fail('conflict','This preparation expired'); end if;
  if v.state->>'intent' <> 'report' or v.shift_id is null then perform app.fail('validation','Choose an assigned shift report'); end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text || v.shift_id::text));
  perform 1 from public.shifts where id=v.shift_id for update;
  select * into r from public.shift_reports where shift_id=v.shift_id and employee_id=auth.uid() for update;
  if r.id is distinct from v.base_report_id or (r.id is not null and r.updated_at is distinct from v.base_report_updated_at) then
    perform app.fail('conflict','The report changed while you were chatting. Start a new preparation to keep the latest edits.');
  end if;
  v_id := app.get_or_create_report(v.shift_id);
  perform app.save_draft(v_id,v.state->'content');
  select * into r from public.shift_reports where id=v_id;
  receipt := jsonb_build_object('kind','draft','id',v_id,'reference',r.reference_code,'status',r.status);
  update internal.assistant_proposals set result=receipt where id=v.id;
  perform app.audit('assistant.draft_saved','assistant_proposal',v.id,app.my_department(),jsonb_build_object('report_id',v_id));
  return receipt;
end $$;
revoke all on function app.save_assistant_draft(uuid,integer) from public,anon;
grant execute on function app.save_assistant_draft(uuid,integer) to authenticated;
