-- Hospital terminology for everything the database writes for people to read: notifications,
-- emails and error messages. Each department names its roles and records itself (Head Nurse,
-- Chief Medical Technologist, shift endorsement, concern…), so the wording is applied from the
-- recipient's (or the signed-in user's) department settings, with general hospital defaults.

create function app.department_terms(p_department uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'head', coalesce(nullif(d.experience ->> 'supervisor_label', ''), 'department head'),
    'staff', coalesce(nullif(d.experience ->> 'staff_label', ''), 'staff'),
    'report', lower(coalesce(nullif(d.experience ->> 'report_label', ''), 'shift endorsement')),
    'issue', lower(coalesce(nullif(d.experience ->> 'issue_label', ''), 'concern')))
  from (select 1) one left join public.departments d on d.id = p_department
$$;

-- Rewrites general wording into the department's hospital terms. Whole words only.
create function app.hospital_wording(p_text text, p_department uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t jsonb := app.department_terms(p_department);
  v text := p_text;
  head text := t ->> 'head';
  head_cap text := upper(left(t ->> 'head', 1)) || substr(t ->> 'head', 2);
  issue text := t ->> 'issue';
  report text := t ->> 'report';
begin
  if v is null or v = '' then return v; end if;
  -- Reports and handovers are shift endorsements.
  v := regexp_replace(v, '\mend-of-shift report\M', report, 'g');
  v := regexp_replace(v, '\mshift reports\M', report || 's', 'gi');
  v := regexp_replace(v, '\mshift report\M', report, 'gi');
  v := regexp_replace(v, '\mMissing report\M', 'Missing ' || report, 'g');
  v := regexp_replace(v, '\mbefore it is handed over\M', 'before it is endorsed to the next shift', 'g');
  v := regexp_replace(v, '\mhandovers\M', 'endorsements', 'g');
  v := regexp_replace(v, '\mhandover\M', 'endorsement', 'g');
  v := regexp_replace(v, '\mHandover\M', 'Endorsement', 'g');
  -- People.
  v := regexp_replace(v, '\mA supervisor\M', 'The ' || head, 'g');
  v := regexp_replace(v, '\ma supervisor\M', 'the ' || head, 'g');
  v := regexp_replace(v, '\mYour supervisor\M', 'Your ' || head, 'g');
  v := regexp_replace(v, '\myour supervisor\M', 'your ' || head, 'g');
  v := regexp_replace(v, '\mSupervisors\M', 'Department heads', 'g');
  v := regexp_replace(v, '\msupervisors\M', 'department heads', 'g');
  v := regexp_replace(v, '\mSupervisor\M', head_cap, 'g');
  v := regexp_replace(v, '\msupervisor\M', head, 'g');
  v := regexp_replace(v, '\mThis employee\M', 'This staff member', 'g');
  v := regexp_replace(v, '\mThat employee\M', 'That staff member', 'g');
  v := regexp_replace(v, '\mthe employee\M', 'the staff member', 'g');
  v := regexp_replace(v, '\memployees\M', 'staff', 'g');
  v := regexp_replace(v, '\mEmployees\M', 'Staff', 'g');
  v := regexp_replace(v, '\memployee\M', 'staff member', 'g');
  -- Concerns and records.
  v := regexp_replace(v, '\missues\M', issue || 's', 'g');
  v := regexp_replace(v, '\mIssues\M', upper(left(issue, 1)) || substr(issue, 2) || 's', 'g');
  v := regexp_replace(v, '\missue\M', issue, 'g');
  v := regexp_replace(v, '\mIssue\M', upper(left(issue, 1)) || substr(issue, 2), 'g');
  v := regexp_replace(v, '\msource records\M', 'unit records', 'g');
  -- Mica's report preparation.
  v := replace(v, 'A simulated draft (development mode, no AI called) is ready for verification.', 'A Mica practice draft (no AI connected) is ready for your approval.');
  v := replace(v, 'An AI-generated draft is ready for verification.', 'Mica''s draft is ready for your approval.');
  return v;
end $$;

-- Every message the database raises for a person is worded for their department.
create or replace function app.fail(p_code text, p_detail text) returns void
language plpgsql as $$
declare
  v_department uuid;
begin
  begin
    v_department := app.my_department();
  exception when others then
    v_department := null;
  end;
  raise exception 'SH:%', p_code using errcode = 'P0001', detail = app.hospital_wording(p_detail, v_department);
end $$;

-- Every notification (and the email or SMS made from it) is worded for the recipient's department.
create or replace function app.notify(
  p_recipient uuid, p_kind text, p_title text, p_body text, p_link text, p_event_key text,
  p_automation_event uuid default null, p_external boolean default true
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_profile public.profiles;
  v_id uuid;
begin
  select * into v_profile from public.profiles where id = p_recipient;
  if not found or not v_profile.is_active then
    return null;
  end if;

  insert into public.notifications (recipient_id, kind, title, body, link, event_key)
  values (p_recipient, p_kind, app.hospital_wording(p_title, v_profile.department_id),
          coalesce(app.hospital_wording(p_body, v_profile.department_id), ''), p_link, p_event_key)
  on conflict (recipient_id, event_key) do nothing
  returning id into v_id;

  if v_id is null or not p_external then
    return v_id;
  end if;

  if v_profile.notify_email then
    insert into public.notification_deliveries (notification_id, recipient_id, automation_event_id, channel, address, idempotency_key)
    values (v_id, p_recipient, p_automation_event, 'email', v_profile.email, v_id::text || ':email')
    on conflict (idempotency_key) do nothing;
  end if;

  if v_profile.notify_sms and v_profile.phone is not null and app.setting_bool('sms_enabled', false) then
    insert into public.notification_deliveries (notification_id, recipient_id, automation_event_id, channel, address, idempotency_key)
    values (v_id, p_recipient, p_automation_event, 'sms', v_profile.phone, v_id::text || ':sms')
    on conflict (idempotency_key) do nothing;
  end if;

  return v_id;
end $$;

-- Email templates.
update public.notification_templates set subject = 'Incoming shift endorsement ready for your shift',
  body = E'Hello {{recipient_name}},\n\nAn approved shift endorsement is waiting for you. Please sign in and acknowledge it before starting your shift:\n{{link}}\n\nFor patient privacy, endorsement content is not included in email.'
  where key = 'handover_delivered' and subject = 'Incoming handover ready for your shift';
update public.notification_templates set
  body = E'Hello {{recipient_name}},\n\nA shift endorsement is waiting for your approval.\n\nReview it here: {{link}}'
  where key = 'review_required' and body like '%A shift report is waiting for your verification.%';
update public.notification_templates set
  body = replace(body, 'For privacy, report content is not included in email.', 'For patient privacy, endorsement content is not included in email.')
  where key = 'default';

-- Notifications already sent read the same way (wording only; nothing else changes).
update public.notifications n set title = app.hospital_wording(n.title, p.department_id), body = app.hospital_wording(n.body, p.department_id)
  from public.profiles p where p.id = n.recipient_id;

revoke all on function app.department_terms(uuid), app.hospital_wording(text, uuid) from public, anon;
grant execute on function app.department_terms(uuid), app.hospital_wording(text, uuid) to authenticated;
