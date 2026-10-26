import type { Services } from '../http/context';
import type { Queryable } from '../db/types';

/**
 * SYNTHETIC DEMONSTRATION DATA. Every person, number and event here is invented.
 * Local test accounts only — never reuse these passwords anywhere else.
 */
export const DEMO_PASSWORD = 'demo-handover-2026';

export const DEMO_ACCOUNTS = [
  { key: 'admin', email: 'admin@demo.test', full_name: 'Alex Reyes', role: 'admin', dept: null },
  { key: 'manager', email: 'maria.santos@demo.test', full_name: 'Maria Santos', role: 'manager', dept: 'WHO' },
  { key: 'juan', email: 'juan.delacruz@demo.test', full_name: 'Juan Dela Cruz', role: 'employee', dept: 'WHO' },
  { key: 'ana', email: 'ana.lim@demo.test', full_name: 'Ana Lim', role: 'employee', dept: 'WHO' },
  { key: 'ben', email: 'ben.torres@demo.test', full_name: 'Ben Torres', role: 'employee', dept: 'WHO' },
  { key: 'facmanager', email: 'rico.navarro@demo.test', full_name: 'Rico Navarro', role: 'manager', dept: 'FAC' },
  { key: 'liza', email: 'liza.ramos@demo.test', full_name: 'Liza Ramos', role: 'employee', dept: 'FAC' },
] as const;

type Key = (typeof DEMO_ACCOUNTS)[number]['key'];

const val = async <T>(q: Queryable, sql: string, params: unknown[] = []) => (await q.query<{ v: T }>(sql, params))[0]!.v;

export interface SeedResult {
  accounts: { email: string; role: string; full_name: string }[];
}

export async function seedDemo(services: Services, opts: { onlyIfEmpty: boolean }): Promise<SeedResult | null> {
  const { db, auth } = services;
  const existing = await db.asService((q) => val<number>(q, 'select count(*)::int as v from public.profiles'));
  if (opts.onlyIfEmpty && existing > 0) return null;

  const ids = {} as Record<Key, string>;
  for (const a of DEMO_ACCOUNTS) ids[a.key] = await auth.createUser(a.email, DEMO_PASSWORD);

  // Bootstrap the first administrator directly; everything after goes through checked functions.
  await db.asService((q) =>
    q.query(`insert into public.profiles (id, full_name, email, role) values ($1, $2, $3, 'admin')`, [ids.admin, 'Alex Reyes', 'admin@demo.test']),
  );

  const deps = await db.asUser(ids.admin, async (q) => {
    const who = await val<string>(q, `select app.admin_upsert_department(null, 'WHO', 'Warehouse Operations', 'Asia/Manila') as v`);
    const fac = await val<string>(q, `select app.admin_upsert_department(null, 'FAC', 'Facilities', 'Asia/Manila') as v`);
    const demoTeam = await val<string>(q, `select app.admin_upsert_team(null, $1, 'Demo Line') as v`, [who]);
    for (const a of DEMO_ACCOUNTS) {
      if (a.role === 'admin') continue;
      await q.query('select app.admin_create_profile($1, $2, $3, $4, $5, $6, null)', [
        ids[a.key],
        a.full_name,
        a.email,
        a.role,
        a.dept === 'WHO' ? who : fac,
        a.key === 'juan' || a.key === 'ana' || a.key === 'ben' ? demoTeam : null,
      ]);
    }
    const templates: [string, string, string][] = [
      ['Morning', '06:00', '14:00'],
      ['Afternoon', '14:00', '22:00'],
      ['Night', '22:00', '06:00'],
    ];
    for (const [name, start, end] of templates) {
      const t = await val<string>(q, `select app.admin_upsert_template(null, $1, null, $2, $3::time, $4::time, 30, 30, true, true) as v`, [who, name, start, end]);
      await q.query(`select app.admin_generate_shifts($1, (now() at time zone 'Asia/Manila')::date - 1, (now() at time zone 'Asia/Manila')::date + 6, $2)`, [t, ids.manager]);
    }
    const facT = await val<string>(q, `select app.admin_upsert_template(null, $1, null, 'Day', '07:00'::time, '19:00'::time, 30, 30, true, true) as v`, [fac]);
    await q.query(`select app.admin_generate_shifts($1, (now() at time zone 'Asia/Manila')::date - 1, (now() at time zone 'Asia/Manila')::date + 6, $2)`, [facT, ids.facmanager]);

    // A regular future shift for Juan so the "upcoming" list is realistic.
    const tomorrowMorning = await val<string>(
      q,
      `select id as v from public.shifts where department_id = $1 and label = 'Morning' and shift_date = (now() at time zone 'Asia/Manila')::date + 1`,
      [who],
    );
    await q.query('select app.admin_assign_employee($1, $2)', [tomorrowMorning, ids.juan]);
    const facToday = await val<string>(
      q,
      `select id as v from public.shifts where department_id = $1 and shift_date = (now() at time zone 'Asia/Manila')::date`,
      [fac],
    );
    await q.query('select app.admin_assign_employee($1, $2)', [facToday, ids.liza]);
    return { who, fac, demoTeam };
  });

  await createDemoTimeline(services, ids.admin);

  await db.asUser(ids.manager, async (q) => {
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
  await db.asUser(ids.facmanager, async (q) => {
    await q.query(`select app.raise_issue('Roof drain near Bay 2 clogged', 'Visible water pooling after rain.', 'medium', false)`);
  });

  return { accounts: DEMO_ACCOUNTS.map((a) => ({ email: a.email, role: a.role, full_name: a.full_name })) };
}

/**
 * Creates an outgoing shift whose reporting window is open right now and the incoming shift
 * that follows it, so the full workflow can be demonstrated at any time of day.
 */
export async function createDemoTimeline(services: Services, adminId: string): Promise<{ outgoing: string; incoming: string }> {
  const { db } = services;
  // Email is not readable through the user role (column-level privacy), so resolve ids here.
  const people = await db.asService((q) =>
    q.query<{ id: string; email: string }>(`select id, email from public.profiles where email = any($1)`, [
      ['juan.delacruz@demo.test', 'ana.lim@demo.test', 'ben.torres@demo.test', 'maria.santos@demo.test'],
    ]),
  );
  const byEmail = Object.fromEntries(people.map((p) => [p.email, p.id]));
  return db.asUser(adminId, async (q) => {
    const team = await q.query<{ id: string; department_id: string }>(
      `select t.id, t.department_id from public.teams t join public.departments d on d.id = t.department_id
        where d.code = 'WHO' and t.name = 'Demo Line'`,
    );
    if (!team[0]) throw new Error('Demo team not found — run the full seed first');
    const { id: teamId, department_id: dept } = team[0];
    // Earlier demo shifts that would overlap the new pair would otherwise receive its handover.
    const overlapping = await q.query<{ id: string; supervisor_id: string | null }>(
      `select id, supervisor_id from public.shifts
        where team_id = $1 and status = 'scheduled' and starts_at > date_trunc('minute', now()) - interval '7 hours 40 minutes'`,
      [teamId],
    );
    for (const s of overlapping) await q.query(`select app.admin_update_shift($1, $2, 'cancelled')`, [s.id, s.supervisor_id]);
    const outgoing = await val<string>(
      q,
      `select app.admin_create_shift($1, $2, 'Demo Line — Outgoing', date_trunc('minute', now()) - interval '7 hours 40 minutes',
              date_trunc('minute', now()) + interval '20 minutes', 30, 90, $3, true) as v`,
      [dept, teamId, byEmail['maria.santos@demo.test']],
    );
    const incoming = await val<string>(
      q,
      `select app.admin_create_shift($1, $2, 'Demo Line — Incoming', date_trunc('minute', now()) + interval '20 minutes',
              date_trunc('minute', now()) + interval '8 hours 20 minutes', 30, 90, $3, true) as v`,
      [dept, teamId, byEmail['maria.santos@demo.test']],
    );
    await q.query('select app.admin_assign_employee($1, $2)', [outgoing, byEmail['juan.delacruz@demo.test']]);
    await q.query('select app.admin_assign_employee($1, $2)', [incoming, byEmail['ana.lim@demo.test']]);
    await q.query('select app.admin_assign_employee($1, $2)', [incoming, byEmail['ben.torres@demo.test']]);
    return { outgoing, incoming };
  });
}
