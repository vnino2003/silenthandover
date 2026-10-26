import type { Services } from '../http/context';
import type { Queryable } from '../db/types';

/**
 * SYNTHETIC DEMONSTRATION DATA. Every person, number and event here is invented.
 * Local test accounts only — never reuse these passwords anywhere else.
 *
 * The demo is one warehouse department. More departments can be added later from the
 * admin portal without code changes; each gets its own supervisor and stays separate.
 */
export const DEMO_PASSWORD = 'demo-handover-2026';
export const DEMO_DEPARTMENT = { code: 'WH', name: 'Warehouse Inventory', timezone: 'Asia/Manila' } as const;

export const DEMO_ACCOUNTS = [
  { key: 'admin', email: 'admin@demo.test', full_name: 'Alex Reyes', role: 'admin', dept: null },
  { key: 'manager', email: 'maria.santos@demo.test', full_name: 'Maria Santos', role: 'manager', dept: 'WH' },
  { key: 'juan', email: 'juan.delacruz@demo.test', full_name: 'Juan Dela Cruz', role: 'employee', dept: 'WH' },
  { key: 'ana', email: 'ana.lim@demo.test', full_name: 'Ana Lim', role: 'employee', dept: 'WH' },
  { key: 'ben', email: 'ben.torres@demo.test', full_name: 'Ben Torres', role: 'employee', dept: 'WH' },
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
  opts: { onlyIfEmpty: boolean; includeSecondDepartment?: boolean },
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
      WH: await val<string>(q, `select app.admin_upsert_department(null, $1, $2, $3) as v`, [
        DEMO_DEPARTMENT.code,
        DEMO_DEPARTMENT.name,
        DEMO_DEPARTMENT.timezone,
      ]),
    };
    if (opts.includeSecondDepartment) {
      depts.FAC = await val<string>(q, `select app.admin_upsert_department(null, 'FAC', 'Facilities', 'Asia/Manila') as v`);
    }
    // The demo shifts use their own team so their handover goes to the demo incoming shift,
    // not to a regular warehouse shift that happens to start in between.
    await q.query(`select app.admin_upsert_team(null, $1, $2)`, [depts.WH, DEMO_TEAM]);
    for (const a of accounts) {
      if (a.role === 'admin') continue;
      await q.query('select app.admin_create_profile($1, $2, $3, $4, $5, null, null)', [ids[a.key], a.full_name, a.email, a.role, depts[a.dept!]]);
    }
  });

  // Supervisor: the day-to-day schedule for their own department.
  await db.asUser(ids.manager!, async (q) => {
    await q.query(`select app.apply_schedule_preset('warehouse_extended')`);
    const templates = await q.query<{ id: string }>(`select id from public.shift_templates where department_id = app.my_department() and is_active order by start_time`);
    for (const template of templates) await q.query(`select app.generate_shifts($1, ${today} - 1, ${today} + 6, $2)`, [template.id, ids.manager]);
    // A regular future shift for Juan so the "upcoming" list is realistic.
    const tomorrowOpening = await val<string>(
      q,
      `select id as v from public.shifts where department_id = app.my_department() and label = 'Opening' and shift_date = ${today} + 1`,
    );
    await q.query('select app.assign_to_shift($1, $2)', [tomorrowOpening, ids.juan]);
  });

  await createDemoTimeline(services, ids.manager!);

  await db.asUser(ids.manager!, async (q) => {
    await q.query(
      `select app.add_operational_record('maintenance', 'MR-2291', 'Conveyor C3 belt tension adjusted', 'Tension set to spec by maintenance tech; belt tracking OK at test run.', now() - interval '3 hours')`,
    );
    await q.query(
      `select app.add_operational_record('inventory', 'INV-1026', 'Cycle count — Aisle 7', 'System count 48 pallets of SKU 55-210 at 08:00.', now() - interval '6 hours')`,
    );
    await q.query(
      `select app.add_operational_record('policy', 'POL-SAFE-01', 'Forklift defects', 'A forklift with a reported brake or steering defect must be tagged out of service until maintenance signs it off.', now() - interval '30 days')`,
    );
    const forklift = await val<{ id: string }>(q, `select app.raise_issue('Forklift FL-02 brake feels soft', 'Reported by operators on two shifts. Tagged out pending maintenance check.', 'high', true) as v`);
    const dock = await val<{ id: string }>(q, `select app.raise_issue('Dock 3 door sensor intermittent', 'Door sometimes stops halfway. Workaround: manual close.', 'medium', false) as v`);
    await q.query(`select app.transition_issue($1, 'in_progress', 'Maintenance ticket raised; parts on order.')`, [dock.id]);
    await q.query('select app.assign_issue($1, $2)', [forklift.id, ids.juan]);
  });

  if (opts.includeSecondDepartment) {
    await db.asUser(ids.facmanager!, async (q) => {
      const t = await val<string>(q, `select app.upsert_shift_template(null, null, 'Day', '07:00'::time, '19:00'::time, 30, 30, true, true) as v`);
      await q.query(`select app.generate_shifts($1, ${today} - 1, ${today} + 6, $2)`, [t, ids.facmanager]);
      const facToday = await val<string>(q, `select id as v from public.shifts where department_id = app.my_department() and shift_date = ${today}`);
      await q.query('select app.assign_to_shift($1, $2)', [facToday, ids.liza]);
      await q.query(`select app.raise_issue('Roof drain near Bay 2 clogged', 'Visible water pooling after rain.', 'medium', false)`);
    });
  }

  return { accounts: accounts.map((a) => ({ email: a.email, role: a.role, full_name: a.full_name })) };
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
    const outgoing = await val<string>(
      q,
      `select app.create_shift($1, 'Demo shift — Outgoing', date_trunc('minute', now()) - interval '7 hours 40 minutes',
              date_trunc('minute', now()) + interval '20 minutes', 30, 90, auth.uid(), true) as v`,
      [team.id],
    );
    const incoming = await val<string>(
      q,
      `select app.create_shift($1, 'Demo shift — Incoming', date_trunc('minute', now()) + interval '20 minutes',
              date_trunc('minute', now()) + interval '8 hours 20 minutes', 30, 90, auth.uid(), true) as v`,
      [team.id],
    );
    await q.query('select app.assign_to_shift($1, $2)', [outgoing, byEmail['juan.delacruz@demo.test']]);
    await q.query('select app.assign_to_shift($1, $2)', [incoming, byEmail['ana.lim@demo.test']]);
    await q.query('select app.assign_to_shift($1, $2)', [incoming, byEmail['ben.torres@demo.test']]);
    return { outgoing, incoming };
  });
}
