import type { Services } from '../http/context';
import { DEMO_SAMPLE_REPORT, NEWBORN_EXPERIENCE } from '@sh/shared';
import type { Queryable } from '../db/types';

/**
 * SYNTHETIC DEMONSTRATION DATA. Every person, number and event here is invented.
 * Local test accounts only — never reuse these passwords anywhere else.
 *
 * The demo is the Nursery (newborn care). More departments can be added later from the
 * admin portal without code changes; each gets its own supervisor and stays separate.
 */
export const DEMO_PASSWORD = 'demo-handover-2026';
export const DEMO_DEPARTMENT = { code: 'NC', name: 'Nursery', timezone: 'Asia/Manila' } as const;

export const DEMO_ACCOUNTS = [
  { key: 'admin', email: 'admin@demo.test', full_name: 'Alex Reyes', role: 'admin', dept: null },
  { key: 'manager', email: 'maria.santos@demo.test', full_name: 'Maria Santos', role: 'manager', dept: 'NC' },
  { key: 'juan', email: 'juan.delacruz@demo.test', full_name: 'Juan Dela Cruz', role: 'employee', dept: 'NC' },
  { key: 'ana', email: 'ana.lim@demo.test', full_name: 'Ana Lim', role: 'employee', dept: 'NC' },
  { key: 'ben', email: 'ben.torres@demo.test', full_name: 'Ben Torres', role: 'employee', dept: 'NC' },
  { key: 'carla', email: 'carla.mendoza@demo.test', full_name: 'Carla Mendoza', role: 'employee', dept: 'NC' },
  { key: 'daniel', email: 'daniel.ramos@demo.test', full_name: 'Daniel Ramos', role: 'employee', dept: 'NC' },
] as const;

/** Only seeded by the tests, to prove departments cannot see each other's data. */
export const SECOND_DEPARTMENT_ACCOUNTS = [
  { key: 'facmanager', email: 'rico.navarro@demo.test', full_name: 'Rico Navarro', role: 'manager', dept: 'FAC' },
  { key: 'liza', email: 'liza.ramos@demo.test', full_name: 'Liza Ramos', role: 'employee', dept: 'FAC' },
] as const;

const DEMO_TEAM = 'Demo';
const val = async <T>(q: Queryable, sql: string, params: unknown[] = []) => (await q.query<{ v: T }>(sql, params))[0]!.v;
const today = `(now() at time zone 'Asia/Manila')::date`;

export interface SeedResult {
  accounts: { email: string; role: string; full_name: string }[];
}

export async function seedDemo(
  services: Services,
  // sampleActivity: sample tickets, source records, a week's crew and an open reporting window.
  // Used by the automated tests; a normal first start creates the setup only (live use).
  opts: { onlyIfEmpty: boolean; includeSecondDepartment?: boolean; sampleActivity?: boolean; presentation?: boolean },
): Promise<SeedResult | null> {
  const { db, auth } = services;
  const existing = await db.asService((q) => val<number>(q, 'select count(*)::int as v from public.profiles'));
  if (opts.onlyIfEmpty && existing > 0) return null;

  const accounts = [...DEMO_ACCOUNTS, ...(opts.includeSecondDepartment ? SECOND_DEPARTMENT_ACCOUNTS : [])];
  const ids: Record<string, string> = {};
  for (const a of accounts) ids[a.key] = await auth.createUser(a.email, DEMO_PASSWORD);

  // Bootstrap the first administrator directly; everything after goes through checked functions.
  await db.asService((q) =>
    q.query(`insert into public.profiles (id, full_name, email, role) values ($1, $2, $3, 'admin')`, [ids.admin, 'Alex Reyes', 'admin@demo.test']),
  );

  // Administrator: one-time setup — the department, its people, and the demo team.
  await db.asUser(ids.admin!, async (q) => {
    const depts: Record<string, string> = {
      NC: await val<string>(q, `select app.admin_upsert_department(null, $1, $2, $3) as v`, [
        DEMO_DEPARTMENT.code,
        DEMO_DEPARTMENT.name,
        DEMO_DEPARTMENT.timezone,
      ]),
    };
    await q.query('select app.set_department_experience($1,$2::jsonb)', [depts.NC, JSON.stringify(NEWBORN_EXPERIENCE)]);
    if (opts.includeSecondDepartment) {
      depts.FAC = await val<string>(q, `select app.admin_upsert_department(null, 'FAC', 'Facilities', 'Asia/Manila') as v`);
    }
    // The sample shifts use their own team so their handover goes to the sample incoming shift,
    // not to a regular department shift that happens to start in between.
    if (opts.sampleActivity) await q.query(`select app.admin_upsert_team(null, $1, $2)`, [depts.NC, DEMO_TEAM]);
    for (const a of accounts) {
      if (a.role === 'admin') continue;
      await q.query('select app.admin_create_profile($1, $2, $3, $4, $5, null, null)', [ids[a.key], a.full_name, a.email, a.role, depts[a.dept!]]);
    }
  });

  // Supervisor: the day-to-day schedule for their own department.
  await db.asUser(ids.manager!, async (q) => {
    // Two shifts: Morning 6 AM – 2 PM hands over to Afternoon 2 PM – 10 PM.
    await q.query('select app.apply_schedule_preset($1)', [opts.presentation ? 'continuous_24h' : 'two_shift']);
    const templates = await q.query<{ id: string }>(`select id from public.shift_templates where department_id = app.my_department() and is_active order by start_time`);
    for (const template of templates) await q.query(`select app.generate_shifts($1, ${today} - 1, ${today} + 6, $2)`, [template.id, ids.manager]);
    if (!opts.sampleActivity) return;
    // A realistic week from tomorrow: Juan on Morning, Ana and Ben on Afternoon.
    // (Today is covered by the sample shifts below.)
    const crew = await q.query<{ id: string; label: string }>(
      `select id, label from public.shifts where department_id = app.my_department() and template_id is not null
          and shift_date between ${today} + 1 and ${today} + 6`,
    );
    for (const s of crew) {
      const people = s.label === 'Morning' || s.label === 'Day' ? [ids.juan] : s.label === 'Night' ? [ids.carla, ids.daniel] : [ids.ana, ids.ben];
      for (const who of people) await q.query('select app.assign_to_shift($1, $2)', [s.id, who]);
    }
  });

  if (opts.sampleActivity) await createDemoTimeline(services, ids.manager!);

  if (opts.sampleActivity) await db.asUser(ids.manager!, async (q) => {
    await q.query(
      `select app.add_operational_record('maintenance', 'BIO-NC-020', 'Unit equipment readiness review', 'Biomedical engineering completed the scheduled inspection of the spare equipment set. NB-02 is excluded pending a separate wheel-lock inspection.', now() - interval '3 hours')`,
    );
    await q.query(
      `select app.add_operational_record('quality', 'NC-READY-01', 'Newborn unit readiness checklist', 'Rooms 1–4 prepared; emergency supply seals checked against the local checklist. No patient information is included.', now() - interval '6 hours')`,
    );
    await q.query(
      `select app.add_operational_record('policy', 'POL-NC-01', 'Operational handover and equipment escalation', 'Synthetic demo policy: use approved service references in operational handovers; report equipment faults to the supervisor and authorized engineering team. Clinical information stays in the approved clinical record.', now() - interval '30 days')`,
    );
    await q.query(`select app.add_operational_record('staffing', 'NC-ROSTER-01', 'Care-team coverage and incoming briefing', 'Incoming briefing covers open service requests and unit-readiness references.', now() - interval '2 hours')`);
    const equipment = await val<{ id: string }>(q, `select app.raise_issue('Bassinet NB-02 wheel lock needs inspection', 'Removed from use in the preparation room. Biomedical engineering request BIO-NC-021 is awaiting inspection.', 'high', true) as v`);
    const facilities = await val<{ id: string }>(q, `select app.raise_issue('Family consultation room call bell intermittent', 'Facilities request FAC-NC-014 is open. The supervisor has been informed.', 'medium', false) as v`);
    await q.query(`select app.transition_issue($1, 'in_progress', 'Facilities team acknowledged FAC-NC-014; inspection is in progress.')`, [facilities.id]);
    await q.query('select app.assign_issue($1, $2)', [equipment.id, ids.juan]);
  });

  if (opts.includeSecondDepartment) {
    await db.asUser(ids.facmanager!, async (q) => {
      const t = await val<string>(q, `select app.upsert_shift_template(null, null, 'Day', '07:00'::time, '19:00'::time, 30, 30, true, true) as v`);
      await q.query(`select app.generate_shifts($1, ${today} - 1, ${today} + 6, $2)`, [t, ids.facmanager]);
      const facToday = await val<string>(q, `select id as v from public.shifts where department_id = app.my_department() and shift_date = ${today}`);
      await q.query('select app.assign_to_shift($1, $2)', [facToday, ids.liza]);
      await q.query(`select app.raise_issue('Staff entrance light needs attention', 'Facilities inspection requested for the staff entrance.', 'medium', false)`);
    });
  }

  if (opts.presentation && opts.sampleActivity) {
    await db.asUser(ids.juan!, async (q) => {
      const [s] = await q.query<{ id: string }>(`select s.id from public.shifts s join public.shift_assignments a on a.shift_id=s.id where a.employee_id=auth.uid() and a.removed_at is null and s.label like '% (demo)' and s.status='scheduled' order by s.created_at desc limit 1`);
      if (s) { const id = await val<string>(q, 'select app.get_or_create_report($1) as v', [s.id]); await q.query('select app.save_draft($1,$2::jsonb)', [id, JSON.stringify(DEMO_SAMPLE_REPORT)]); }
    });
  }
  return { accounts: accounts.map((a) => ({ email: a.email, role: a.role, full_name: a.full_name })) };
}

/**
 * LOCAL MODE ONLY: wipes all activity — shifts and assignments, reports and their AI runs,
 * handovers, issues ("tickets"), photos, notifications and source records — to start from a
 * clean slate. Accounts, departments, shift patterns and the audit log stay; the sample
 * team the tests use is removed too.
 * TRUNCATE is used because the history tables refuse row deletes by design; it is listed
 * without CASCADE so a table added later is never wiped by accident.
 */
export async function resetActivity(services: Services, actorId: string) {
  const tables = [
    'internal.assistant_proposals',
    'public.issue_photos', 'public.issue_updates', 'public.issue_assignments', 'public.operational_issues',
    'public.handover_routes', 'public.handover_acknowledgments', 'public.handover_deliveries', 'public.handover_approvals',
    'public.ai_analysis_runs', 'internal.analysis_inputs', 'public.notification_deliveries', 'public.notifications',
    'public.automation_events', 'public.report_revisions', 'public.report_window_overrides', 'public.shift_reports',
    'public.shift_assignments', 'public.shifts', 'public.operational_records',
  ];
  return services.db.asService(async (q) => {
    const [counts] = await q.query<{ shifts: number; reports: number; issues: number }>(
      `select (select count(*)::int from public.shifts) as shifts, (select count(*)::int from public.shift_reports) as reports,
              (select count(*)::int from public.operational_issues) as issues`,
    );
    await q.query(`truncate ${tables.join(', ')}`);
    await q.query(
      `delete from public.teams t where t.name = $1
          and not exists (select 1 from public.profiles p where p.team_id = t.id)
          and not exists (select 1 from public.shift_templates st where st.team_id = t.id)`,
      [DEMO_TEAM],
    );
    await q.query(
      `insert into public.audit_logs (actor_id, actor_role, action, entity_type, details) values ($1, 'admin', 'activity.reset', 'system', $2::jsonb)`,
      [actorId, JSON.stringify(counts)],
    );
    return counts!;
  });
}

/**
 * Creates an outgoing shift whose reporting window is open right now and the incoming shift
 * that follows it, so the full workflow can be demonstrated at any time of day.
 * Runs as the department's supervisor, who owns the schedule.
 */
export async function createDemoTimeline(services: Services, supervisorId: string): Promise<{ outgoing: string; incoming: string }> {
  const { db } = services;
  // Email is not readable through the user role (column-level privacy), so resolve ids here.
  const people = await db.asService((q) =>
    q.query<{ id: string; email: string }>(`select id, email from public.profiles where email = any($1)`, [
      ['juan.delacruz@demo.test', 'ana.lim@demo.test', 'ben.torres@demo.test'],
    ]),
  );
  const byEmail = Object.fromEntries(people.map((p) => [p.email, p.id]));
  return db.asUser(supervisorId, async (q) => {
    const [team] = await q.query<{ id: string }>(`select id from public.teams where department_id = app.my_department() and name = $1`, [DEMO_TEAM]);
    if (!team) throw new Error('Demo team not found — run the full seed first');
    // Earlier demo shifts that overlap the new pair would otherwise receive its handover, and
    // their assignments would trip the overlap guard, so cancel every one of them.
    const overlapping = await q.query<{ id: string; supervisor_id: string | null }>(
      `select id, supervisor_id from public.shifts
        where team_id = $1 and status = 'scheduled'
          and ends_at > date_trunc('minute', now()) - interval '7 hours 40 minutes'
          and starts_at < date_trunc('minute', now()) + interval '8 hours 20 minutes'`,
      [team.id],
    );
    for (const s of overlapping) await q.query(`select app.update_shift($1, $2, 'cancelled')`, [s.id, s.supervisor_id]);
    // The demo workers may also be on regular shifts in the same hours; free them for the demo.
    const clashes = await q.query<{ shift_id: string; employee_id: string }>(
      `select a.shift_id, a.employee_id from public.shift_assignments a join public.shifts s on s.id = a.shift_id
        where a.removed_at is null and s.status = 'scheduled'
          and ((a.employee_id = $1 and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(date_trunc('minute', now()) - interval '7 hours 40 minutes', date_trunc('minute', now()) + interval '20 minutes', '[)'))
            or (a.employee_id = any($2) and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(date_trunc('minute', now()) + interval '20 minutes', date_trunc('minute', now()) + interval '8 hours 20 minutes', '[)')))`,
      [byEmail['juan.delacruz@demo.test'], [byEmail['ana.lim@demo.test'], byEmail['ben.torres@demo.test']]],
    );
    for (const c of clashes) await q.query('select app.unassign_from_shift($1, $2)', [c.shift_id, c.employee_id]);
    // Regular shifts in the same hours that nobody works would show beside the demo pair as
    // duplicates; the demo stands in for them today.
    const idle = await q.query<{ id: string; supervisor_id: string | null }>(
      `select s.id, s.supervisor_id from public.shifts s
        where s.department_id = app.my_department() and s.status = 'scheduled' and s.team_id is distinct from $1
          and s.ends_at > date_trunc('minute', now()) - interval '7 hours 40 minutes'
          and s.starts_at < date_trunc('minute', now()) + interval '8 hours 20 minutes'
          and not exists (select 1 from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null)
          and not exists (select 1 from public.shift_reports r where r.shift_id = s.id)`,
      [team.id],
    );
    for (const s of idle) await q.query(`select app.update_shift($1, $2, 'cancelled')`, [s.id, s.supervisor_id]);
    // Named after the department's own first two shifts, so the demo reads like a normal day.
    const names = (
      await q.query<{ name: string }>(`select name from public.shift_templates where department_id = app.my_department() and is_active order by start_time limit 2`)
    ).map((t) => t.name);
    const [firstLabel, nextLabel] = [`${names[0] ?? 'Shift 1'} (demo)`, `${names[1] ?? names[0] ?? 'Shift 2'} (demo)`];
    const outgoing = await val<string>(
      q,
      `select app.create_shift($1, $2, date_trunc('minute', now()) - interval '7 hours 40 minutes',
              date_trunc('minute', now()) + interval '20 minutes', 30, 90, auth.uid(), true) as v`,
      [team.id, firstLabel],
    );
    const incoming = await val<string>(
      q,
      `select app.create_shift($1, $2, date_trunc('minute', now()) + interval '20 minutes',
              date_trunc('minute', now()) + interval '8 hours 20 minutes', 30, 90, auth.uid(), true) as v`,
      [team.id, nextLabel],
    );
    await q.query('select app.assign_to_shift($1, $2)', [outgoing, byEmail['juan.delacruz@demo.test']]);
    await q.query('select app.assign_to_shift($1, $2)', [incoming, byEmail['ana.lim@demo.test']]);
    await q.query('select app.assign_to_shift($1, $2)', [incoming, byEmail['ben.torres@demo.test']]);
    return { outgoing, incoming };
  });
}
