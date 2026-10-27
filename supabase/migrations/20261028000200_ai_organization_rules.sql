-- Organization rules: what an administrator adds on top of the locked default prompt rules,
-- for report cleaning and for Mica. Every save is a new version; old versions are never changed,
-- so each AI run can show exactly which rules it used.
create table public.ai_rule_versions (
  version int primary key,
  policy_rules text[] not null default '{}',
  negative_constraints text[] not null default '{}',
  is_default boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint ai_rules_counts check (cardinality(policy_rules) <= 10 and cardinality(negative_constraints) <= 10)
);
alter table public.ai_rule_versions enable row level security;
create policy ai_rule_versions_read on public.ai_rule_versions for select to authenticated using (app.my_role() = 'admin');
revoke insert, update, delete on public.ai_rule_versions from public, anon, authenticated;
grant select on public.ai_rule_versions to authenticated;

-- The system's defaults (packages/shared/src/organization-rules.ts keeps the same text).
insert into public.ai_rule_versions (version, policy_rules, negative_constraints, is_default) values (1,
  array['Use the department''s own words for shifts, roles, places and equipment.',
        'When something is unclear or missing, say so instead of guessing.'],
  array['Do not include patient, client or customer names, bed or room numbers, or other identifiers of the people served.',
        'Do not comment on a person''s character, health or performance; describe the work only.'],
  true);

-- Which rules each AI run used: set on the event when the prompt is built, copied to the run.
alter table public.automation_events add column org_rules_version int references public.ai_rule_versions(version);
alter table public.ai_analysis_runs add column org_rules_version int references public.ai_rule_versions(version);

create function internal.copy_rules_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.org_rules_version is null and new.automation_event_id is not null then
    select org_rules_version into new.org_rules_version from public.automation_events where id = new.automation_event_id;
  end if;
  return new;
end $$;
create trigger ai_analysis_runs_rules_version before insert on public.ai_analysis_runs
  for each row execute function internal.copy_rules_version();

-- Saving is administrator-only and audited. The API checks each rule for injection wording first.
create function app.admin_save_ai_rules(p_policy text[], p_never text[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_version int;
  v_rule text;
begin
  if app.my_role() is distinct from 'admin' then perform app.fail('forbidden', 'Only administrators can change the AI rules'); end if;
  if cardinality(coalesce(p_policy, '{}')) > 10 or cardinality(coalesce(p_never, '{}')) > 10 then
    perform app.fail('validation', 'Use at most 10 rules in each list');
  end if;
  foreach v_rule in array coalesce(p_policy, '{}') || coalesce(p_never, '{}') loop
    if length(trim(v_rule)) < 3 or length(v_rule) > 300 then perform app.fail('validation', 'Each rule needs 3 to 300 characters'); end if;
  end loop;
  perform pg_advisory_xact_lock(hashtext('ai_rule_versions'));
  select coalesce(max(version), 0) + 1 into v_version from public.ai_rule_versions;
  insert into public.ai_rule_versions (version, policy_rules, negative_constraints, created_by)
  values (v_version, coalesce(p_policy, '{}'), coalesce(p_never, '{}'), auth.uid());
  perform app.audit('ai.rules_saved', 'ai_rules', null, null,
    jsonb_build_object('version', v_version, 'policy_rules', cardinality(coalesce(p_policy, '{}')), 'negative_constraints', cardinality(coalesce(p_never, '{}'))));
  return v_version;
end $$;
revoke all on function app.admin_save_ai_rules(text[], text[]) from public, anon;
grant execute on function app.admin_save_ai_rules(text[], text[]) to authenticated;
revoke all on function internal.copy_rules_version() from public, anon, authenticated;
