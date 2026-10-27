alter table public.departments add column experience jsonb not null default '{}'::jsonb;
alter table public.departments add constraint department_experience_object check (jsonb_typeof(experience) = 'object' and pg_column_size(experience) < 16384);
alter table public.operational_records drop constraint operational_records_record_type_check;
alter table public.operational_records add constraint operational_records_record_type_check
  check (record_type in ('maintenance','inventory','dispatch','operations','quality','staffing','policy'));

create function app.set_department_experience(p_id uuid, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_admin() then perform app.fail('forbidden', 'Only administrators configure departments'); end if;
  if jsonb_typeof(p_value) <> 'object' or pg_column_size(p_value) >= 16384 then perform app.fail('validation', 'Invalid department configuration'); end if;
  update public.departments set experience = p_value where id = p_id;
  if not found then perform app.fail('not_found', 'Department not found'); end if;
  perform app.audit('department.experience_updated', 'department', p_id, p_id);
end $$;
revoke all on function app.set_department_experience(uuid,jsonb) from public, anon;
grant execute on function app.set_department_experience(uuid,jsonb) to authenticated;

-- Neutral public name, while preserving older callers and migration history.
alter function app.apply_schedule_preset(text) rename to apply_schedule_preset_legacy;
create function app.apply_schedule_preset(p_preset text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_result jsonb;
begin
  v_result := app.apply_schedule_preset_legacy(case when p_preset = 'extended_hours' then 'warehouse_extended' else p_preset end);
  return v_result || jsonb_build_object('preset', p_preset);
end $$;
revoke all on function app.apply_schedule_preset(text) from public, anon;
grant execute on function app.apply_schedule_preset(text) to authenticated;
