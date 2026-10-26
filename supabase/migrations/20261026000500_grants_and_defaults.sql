-- Function privileges and default configuration.

-- Functions are executable by PUBLIC by default in PostgreSQL; take that away first.
revoke all on all functions in schema app from public;
revoke all on all functions in schema internal from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all functions in schema app from anon';
    execute 'revoke all on all functions in schema internal from anon, authenticated';
  end if;
end $$;

-- Read helpers used inside RLS policies.
grant execute on function
  app.my_role(), app.my_department(), app.is_admin(), app.is_manager_of(uuid), app.in_department(uuid),
  app.window_state(uuid, uuid), app.next_shift(uuid), app.server_now(), app.setting(text),
  app.setting_int(text, int), app.setting_bool(text, boolean), app.issue_transition_allowed(text, text, text)
to authenticated;

-- User actions. Each function checks the caller's identity and role itself.
grant execute on function
  app.get_or_create_report(uuid),
  app.save_draft(uuid, jsonb),
  app.submit_report(uuid, jsonb),
  app.decide_report(uuid, text, jsonb, jsonb, text),
  app.request_reanalysis(uuid),
  app.grant_window_override(uuid, uuid, int, text),
  app.acknowledge_handover(uuid, text),
  app.transition_issue(uuid, text, text),
  app.add_issue_note(uuid, text),
  app.raise_issue(text, text, text, boolean),
  app.assign_issue(uuid, uuid),
  app.add_operational_record(text, text, text, text, timestamptz),
  app.my_profile(),
  app.update_my_preferences(boolean, boolean, text),
  app.mark_notifications_read(uuid[]),
  app.admin_upsert_department(uuid, text, text, text),
  app.admin_upsert_team(uuid, uuid, text),
  app.admin_upsert_template(uuid, uuid, uuid, text, time, time, int, int, boolean, boolean),
  app.admin_generate_shifts(uuid, date, date, uuid),
  app.admin_create_shift(uuid, uuid, text, timestamptz, timestamptz, int, int, uuid, boolean),
  app.admin_update_shift(uuid, uuid, text),
  app.admin_assign_employee(uuid, uuid),
  app.admin_unassign_employee(uuid, uuid),
  app.admin_create_profile(uuid, text, text, text, uuid, uuid, text),
  app.admin_update_user(uuid, text, text, uuid, uuid, text, boolean),
  app.admin_list_users(),
  app.admin_set_setting(text, jsonb),
  app.admin_set_template(text, text, text),
  app.admin_retry_event(uuid),
  app.admin_retry_delivery(uuid),
  app.admin_report_overview()
to authenticated;

-- Internal functions are deliberately NOT granted to authenticated. The API runs them with
-- the database owner connection after verifying the n8n callback secret.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema internal to service_role';
    execute 'grant all on all tables in schema internal to service_role';
    execute 'grant execute on all functions in schema internal to service_role';
  end if;
end $$;

insert into public.app_settings (key, value, description) values
  ('escalation_hours', '12', 'Escalate an active issue to supervisors after this many hours without an update'),
  ('ai_timeout_minutes', '10', 'Treat an AI request as failed if no result arrives within this many minutes'),
  ('ai_max_attempts', '3', 'AI attempts per submission before falling back to manual review'),
  ('pii_retention_days', '30', 'Days to keep pseudonym mappings before automatic deletion'),
  ('missing_report_alerts', 'true', 'Alert supervisors when a reporting window closes without a submission'),
  ('sms_enabled', 'false', 'Queue SMS deliveries (requires an SMS provider to be connected)');

-- Email carries a title and a sign-in link only. Details stay in the app, behind sign-in,
-- so report content is never copied into mailboxes outside the organisation's control.
insert into public.notification_templates (key, subject, body) values
  ('default', '{{title}}', E'Hello {{recipient_name}},

{{title}}.

Sign in to Silent Handover to view the details:
{{link}}

For privacy, report content is not included in email.'),
  ('handover_delivered', 'Incoming handover ready for your shift', E'Hello {{recipient_name}},

An approved handover is waiting for you. Please sign in and acknowledge it before starting work:
{{link}}

For privacy, report content is not included in email.'),
  ('review_required', '{{title}}', E'Hello {{recipient_name}},

A shift report is waiting for your verification.

Review it here: {{link}}');
