// npm run demo:schedule — LOCAL DEMO ONLY.
// Adds a realistic two-week staffing example to the Nursery of the running local
// app: more (fictional) staff with job titles, minimum staffing per shift, rotating assignments,
// weekly rest days, and leave requests in every state. No patient information is involved.
//
// It works through the app's own API (the database is locked by the running server), so every
// rule — overlap checks, leave approval, notifications — applies exactly as for real users.
// Safe to run again: existing staff are reused and duplicates are skipped.
import { DEMO_PASSWORD } from '../seed/demo';

const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '') + '/api';

const NEW_STAFF = [
  { email: 'rosa.villanueva@demo.test', full_name: 'Rosa Villanueva', job_title: 'Nursing Attendant' },
  { email: 'paolo.garcia@demo.test', full_name: 'Paolo Garcia', job_title: 'Staff Nurse' },
  { email: 'mae.santiago@demo.test', full_name: 'Mae Santiago', job_title: 'Nursing Attendant' },
  { email: 'leo.fernandez@demo.test', full_name: 'Leo Fernandez', job_title: 'Staff Nurse' },
  { email: 'grace.aquino@demo.test', full_name: 'Grace Aquino', job_title: 'Staff Nurse' },
];
const EXISTING_TITLES: Record<string, string> = {
  'juan.delacruz@demo.test': 'Nursing Attendant',
  'ana.lim@demo.test': 'Staff Nurse',
  'ben.torres@demo.test': 'Staff Nurse',
  'carla.mendoza@demo.test': 'Staff Nurse',
  'daniel.ramos@demo.test': 'Staff Nurse',
};
// Who normally works which shift, and the weekly rest days of each (ISO weekday, Mon = 1).
const CREW: Record<string, { shift: string; rest: number[] }> = {
  'ana.lim@demo.test': { shift: 'Day', rest: [6, 7] },
  'juan.delacruz@demo.test': { shift: 'Day', rest: [1, 2] },
  'rosa.villanueva@demo.test': { shift: 'Day', rest: [3, 4] },
  'paolo.garcia@demo.test': { shift: 'Day', rest: [5, 6] },
  'ben.torres@demo.test': { shift: 'Evening', rest: [7, 1] },
  'mae.santiago@demo.test': { shift: 'Evening', rest: [3, 4] },
  'grace.aquino@demo.test': { shift: 'Evening', rest: [5, 6] },
  'carla.mendoza@demo.test': { shift: 'Night', rest: [1, 2] },
  'daniel.ramos@demo.test': { shift: 'Night', rest: [4, 5] },
  'leo.fernandez@demo.test': { shift: 'Night', rest: [6, 7] },
};
const MIN_STAFF: Record<string, number> = { Day: 3, Evening: 2, Night: 2 };

type Json = Record<string, any>;
async function call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
async function login(email: string) {
  const r = await call(null, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
  if (r.status !== 200) throw new Error(`Could not sign in as ${email} (${r.status}). Is the local app running with the Newborn Care demo?`);
  return r.body.token as string;
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const ok = (r: { status: number; body: Json }, what: string, allow: number[] = []) => {
  if (r.status >= 400 && !allow.includes(r.status)) throw new Error(`${what}: ${r.status} ${r.body?.error?.message ?? ''}`);
  return r;
};

const admin = await login('admin@demo.test');
const manager = await login('maria.santos@demo.test');

// 1. Staff and job titles.
const users = ok(await call(admin, 'GET', '/admin/users'), 'list users').body as unknown as Json[];
const nc = users.find((u) => u.email === 'maria.santos@demo.test');
if (!nc?.department_id) throw new Error('Maria Santos has no department — install the Newborn Care demo first (npm run demo:hospital).');
for (const s of NEW_STAFF) {
  if (users.some((u) => u.email === s.email)) continue;
  ok(await call(admin, 'POST', '/admin/users', { full_name: s.full_name, email: s.email, password: DEMO_PASSWORD, role: 'employee', department_id: nc.department_id, team_id: null, phone: null }), `create ${s.email}`);
}
const people = (ok(await call(admin, 'GET', '/admin/users'), 'list users').body as unknown as Json[]).filter((u) => u.department_id === nc.department_id);
const idOf = (email: string) => people.find((u) => u.email === email)?.id as string;
for (const [email, title] of [...Object.entries(EXISTING_TITLES), ...NEW_STAFF.map((s) => [s.email, s.job_title] as const)]) {
  if (idOf(email)) ok(await call(admin, 'PATCH', `/admin/users/${idOf(email)}/job-title`, { job_title: title }), `job title ${email}`);
}

// 2. Minimum staffing and two weeks of shifts.
const templates = ok(await call(manager, 'GET', '/manager/templates'), 'templates').body as unknown as Json[];
const active = templates.filter((t) => t.is_active);
for (const t of active) if (MIN_STAFF[t.name] !== undefined) ok(await call(manager, 'PATCH', `/manager/templates/${t.id}/min-staff`, { min_staff: MIN_STAFF[t.name] }), `min staff ${t.name}`);
const board0 = ok(await call(manager, 'GET', `/manager/board?from=${addDays('2026-01-01', 0)}&to=${addDays('2026-01-01', 0)}`), 'board').body;
const today = board0.department.today as string;
const last = addDays(today, 13);
for (const t of active) ok(await call(manager, 'POST', `/manager/templates/${t.id}/generate`, { from: today, to: last, supervisor_id: null }), `generate ${t.name}`);

// 3. Rest days, then the rotation (nobody on a rest day; the API refuses overlaps).
for (const [email, c] of Object.entries(CREW)) {
  if (!idOf(email)) continue;
  ok(await call(manager, 'POST', '/manager/rest-days', { employee_id: idOf(email), from: today, to: last, weekdays: c.rest }), `rest days ${email}`);
}
const board = ok(await call(manager, 'GET', `/manager/board?from=${today}&to=${last}`), 'board').body;
// Earlier example assignments that don't fit the rotation (another shift, or a rest day) are
// taken off, so only the deliberate gaps remain. The relative-time "(demo)" shifts are left alone.
let removed = 0;
for (const s of board.shifts as Json[]) {
  if (s.status !== 'scheduled' || s.template_id === null || Date.parse(s.starts_at) < Date.now()) continue;
  for (const id of s.assignees as string[]) {
    const email = people.find((p) => p.id === id)?.email as string | undefined;
    const c = email ? CREW[email] : undefined;
    if (!c || (c.shift === s.label && !c.rest.includes(isoWeekday(s.shift_date)))) continue;
    if ((await call(manager, 'DELETE', `/manager/schedule/${s.id}/assignments/${id}`)).status === 200) {
      removed++;
      s.assignees = (s.assignees as string[]).filter((x) => x !== id);
    }
  }
}
let assigned = 0;
for (const s of board.shifts as Json[]) {
  if (s.status !== 'scheduled' || s.template_id === null || Date.parse(s.ends_at) < Date.now()) continue;
  for (const [email, c] of Object.entries(CREW)) {
    const id = idOf(email);
    if (!id || c.shift !== s.label || s.assignees.includes(id) || c.rest.includes(isoWeekday(s.shift_date))) continue;
    const r = await call(manager, 'POST', `/manager/schedule/${s.id}/assignments`, { employee_id: id });
    if (r.status === 201) assigned++;
  }
}

// 4. Leave in every state (only if not done before).
const types = ok(await call(manager, 'GET', '/leave-types'), 'leave types').body as unknown as Json[];
const typeId = (name: string) => types.find((t) => t.name === name)?.id as string;
const existingLeave = ok(await call(manager, 'GET', '/manager/leave?scope=all'), 'leave').body as unknown as Json[];
if (!existingLeave.length) {
  const request = async (email: string, type: string, from: number, to: number, reason: string) => {
    const token = await login(email);
    return ok(await call(token, 'POST', '/leave', { leave_type_id: typeId(type), start_date: addDays(today, from), end_date: addDays(today, to), reason }), `leave ${email}`).body.id as string;
  };
  // Approved: Paolo's vacation — the Day shift is one short on those days (shows on the board).
  const paolo = await request('paolo.garcia@demo.test', 'Vacation leave', 3, 4, 'Family event in the province');
  ok(await call(manager, 'POST', `/manager/leave/${paolo}/decision`, { decision: 'approved', note: 'Approved — please hand over the supply check to Rosa.' }), 'approve paolo');
  // Rejected: Ben's request clashes with another absence.
  const ben = await request('ben.torres@demo.test', 'Vacation leave', 5, 5, 'Personal errand');
  ok(await call(manager, 'POST', `/manager/leave/${ben}/decision`, { decision: 'rejected', note: 'Two evening staff are already off that day. Could you take the following week?' }), 'reject ben');
  // Pending: Leo's sick leave would leave a Night shift understaffed — visible before approval.
  await request('leo.fernandez@demo.test', 'Sick leave', 2, 2, 'Medical appointment');
  // Pending: Mae's vacation next week, no shortage.
  await request('mae.santiago@demo.test', 'Vacation leave', 9, 10, '');
}

const staffing = ok(await call(manager, 'GET', `/manager/board?from=${today}&to=${last}`), 'board').body;
console.log(`Newborn Care schedule ready: ${people.length} people, ${assigned} new assignments (${removed} off-rotation ones removed) from ${today} to ${last}.`);
console.log(`Leave requests: ${(ok(await call(manager, 'GET', '/manager/leave?scope=all'), 'leave').body as unknown as Json[]).length}; things needing attention on the board: ${staffing.conflicts.length}.`);
console.log(`New sign-ins use the demo password; e.g. rosa.villanueva@demo.test.`);
