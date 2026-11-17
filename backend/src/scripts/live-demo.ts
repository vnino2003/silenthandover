/**
 * npm run demo:live — fills the LIVE system (or a local one) with a realistic, fictional Nursery team
 * for a presentation. Everything goes through the app's own API, exactly as if people clicked through
 * the pages, so every rule, notification and audit-log entry is genuine.
 *
 * What it creates (all people are fictional, no patient information):
 *   - departments: the Nursery (with the Nursery wording), Human Resources, Accounting Office and the
 *     Nursing Service Office;
 *   - accounts with a password already set (no invitation, no inbox needed) at a reserved .test
 *     domain: a Head Nurse, ten nursing staff, HR, Payroll, Finance and a Chief Nurse (Nursing Service),
 *     with their duties; email alerts are turned off for every one of them;
 *   - Day / Evening / Night patterns, minimum staffing, rest days and a rotation from the start of the
 *     previous cutoff to two weeks ahead;
 *   - source records, open concerns, leave in every state;
 *   - two shift endorsements analysed by Mica: one approved and read by the incoming shift, one
 *     waiting for the Head Nurse's review (to approve live);
 *   - a QR station, the sample pay group, SAMPLE monthly pay, labelled sample attendance for past
 *     duties; the previous cutoff confirmed, certified, locked and its payroll waiting for Finance.
 *
 * Usage: npm run demo:live            (asks for the server, your admin sign-in and a demo password)
 *        npm run demo:live -- --cleanup  (after the presentation: deactivates every demo account)
 * Values can also come from API_URL, ADMIN_EMAIL, ADMIN_PASSWORD, DEMO_PASSWORD, EMAIL_DOMAIN.
 * Passwords are never printed. Safe to run again: what already exists is skipped.
 */
import { createInterface } from 'node:readline/promises';
import { NEWBORN_EXPERIENCE } from '@sh/shared';

type Json = any; // API responses, read loosely (this is a script)

// ---- Who --------------------------------------------------------------------------------------
type Dept = 'NC' | 'HR' | 'ACCT' | 'NSO';
const DEPARTMENTS: Record<Dept, string> = {
  NC: 'Nursery',
  HR: 'Human Resources',
  ACCT: 'Accounting Office',
  NSO: 'Nursing Service Office',
};
const PEOPLE = [
  { key: 'maria', name: 'Maria Santos', role: 'manager', dept: 'NC', title: 'Head Nurse', duties: [] },
  { key: 'ana', name: 'Ana Lim', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'juan', name: 'Juan Dela Cruz', role: 'employee', dept: 'NC', title: 'Nursing Attendant', duties: [] },
  { key: 'rosa', name: 'Rosa Villanueva', role: 'employee', dept: 'NC', title: 'Nursing Attendant', duties: [] },
  { key: 'paolo', name: 'Paolo Garcia', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'ben', name: 'Ben Torres', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'mae', name: 'Mae Santiago', role: 'employee', dept: 'NC', title: 'Nursing Attendant', duties: [] },
  { key: 'grace', name: 'Grace Aquino', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'carla', name: 'Carla Mendoza', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'daniel', name: 'Daniel Ramos', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'leo', name: 'Leo Fernandez', role: 'employee', dept: 'NC', title: 'Staff Nurse', duties: [] },
  { key: 'helen', name: 'Helen Ramos', role: 'employee', dept: 'HR', title: 'HR Officer (Timekeeping)', duties: ['timekeeper', 'hr_admin'] },
  { key: 'pablo', name: 'Pablo Reyes', role: 'employee', dept: 'ACCT', title: 'Payroll Officer', duties: ['payroll_preparer'] },
  { key: 'fiona', name: 'Fiona Tan', role: 'employee', dept: 'ACCT', title: 'Accountant (Finance)', duties: ['finance_approver'] },
  { key: 'nora', name: 'Nora Bautista', role: 'manager', dept: 'NSO', title: 'Chief Nurse (Nursing Service)', duties: ['nursing_service'] },
] as const;
type Key = (typeof PEOPLE)[number]['key'];
// Who normally works which shift, and their weekly rest days (ISO weekday, Mon = 1).
const CREW: Partial<Record<Key, { shift: string; rest: number[] }>> = {
  ana: { shift: 'Day', rest: [6, 7] }, juan: { shift: 'Day', rest: [1, 2] }, rosa: { shift: 'Day', rest: [3, 4] }, paolo: { shift: 'Day', rest: [5, 6] },
  ben: { shift: 'Evening', rest: [7, 1] }, mae: { shift: 'Evening', rest: [3, 4] }, grace: { shift: 'Evening', rest: [5, 6] },
  carla: { shift: 'Night', rest: [1, 2] }, daniel: { shift: 'Night', rest: [4, 5] }, leo: { shift: 'Night', rest: [6, 7] },
};
const MIN_STAFF: Record<string, number> = { Day: 3, Evening: 2, Night: 2 };
const LABEL = 'Entered from the Nursery attendance logbook';

// ---- Small helpers ----------------------------------------------------------------------------
const cleanup = process.argv.includes('--cleanup');
const assumeYes = process.argv.includes('--yes');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoWeekday = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const lastOfMonth = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).toISOString().slice(0, 10);
const step = (text: string) => console.log(`\n▸ ${text}`);

async function ask(label: string, opts: { hidden?: boolean; fallback?: string } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = rl.question(opts.fallback ? `${label} [${opts.fallback}]: ` : `${label}: `);
  // Nothing typed is echoed for passwords.
  if (opts.hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const value = (await answer).trim();
  rl.close();
  if (opts.hidden) process.stdout.write('\n');
  return value || opts.fallback || '';
}
async function setting(env: string, label: string, opts: { hidden?: boolean; fallback?: string } = {}) {
  const v = process.env[env]?.trim() || (await ask(label, opts));
  if (!v) throw new Error(`${label} is required`);
  return v;
}

let API = '';
async function call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/api${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < 6) {
        await sleep(10_000 * (attempt + 1));
        continue;
      }
      let json: Json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { error: { message: text.slice(0, 200) } }; }
      return { status: res.status, body: json };
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(5_000);
    }
  }
}
const ok = (r: { status: number; body: Json }, what: string, allow: number[] = []) => {
  if (r.status >= 300 && !allow.includes(r.status)) throw new Error(`${what}: ${r.status} ${r.body?.error?.message ?? JSON.stringify(r.body)}`);
  return r.body;
};

// Signs in the way the web app does: Supabase Auth on the live server, the API in local mode.
let authConfig: Json;
async function signIn(email: string, password: string): Promise<string> {
  if (authConfig.provider !== 'supabase') return ok(await call(null, 'POST', '/auth/login', { email, password }), `sign in ${email}`).token;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${authConfig.supabase_url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: authConfig.supabase_anon_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.ok && body.access_token) return body.access_token as string;
    if (res.status === 429 && attempt < 6) {
      console.log('  (sign-in limit reached, waiting a minute…)');
      await sleep(60_000);
      continue;
    }
    throw new Error(`Could not sign in as ${email}: ${body.error_description ?? body.msg ?? res.status}`);
  }
}

// ---- Main ---------------------------------------------------------------------------------------
async function main() {
  for (;;) {
    const answer = process.env.API_URL?.trim() || (await ask('Step 1. Server address — just press Enter for production', { fallback: 'https://api-handover.natsgo.app' }));
    if (/^https?:\/\/[^\s@]+$/i.test(answer)) {
      API = answer.replace(/\/+$/, '').replace(/\/api$/, '');
      break;
    }
    if (process.env.API_URL) throw new Error('API_URL must start with https://');
    console.log('  That is not a server address (your email comes in the next step). Just press Enter.');
  }
  console.log(`  Using ${API}`);
  // Wake the server first (a sleeping server can take a moment).
  for (let i = 0; ; i++) {
    const h = await call(null, 'GET', '/health').catch(() => ({ status: 0, body: null }));
    if (h.status === 200) break;
    if (i >= 12) throw new Error(`The API at ${API} does not answer. Open ${API}/api/health in a browser and try again.`);
    console.log('Waiting for the server to wake up…');
    await sleep(5_000);
  }
  authConfig = ok(await call(null, 'GET', '/config'), 'server settings').auth;
  const domain = (process.env.EMAIL_DOMAIN?.trim() || 'starlight.test').toLowerCase();
  const emailOf = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@${domain}`;

  const adminEmail = await setting('ADMIN_EMAIL', 'Step 2. Your admin email (the Gmail you sign in with)');
  const adminPassword = await setting('ADMIN_PASSWORD', 'Step 3. Your admin password (nothing shows while typing)', { hidden: true });
  const admin = await signIn(adminEmail, adminPassword);
  const me = ok(await call(admin, 'GET', '/me'), 'your profile');
  if (me.role !== 'admin') throw new Error(`${adminEmail} is not an administrator`);

  if (cleanup) return runCleanup(admin, domain);

  const demoPassword = await setting('DEMO_PASSWORD', 'Step 4. NEW password for ALL demo accounts, at least 10 characters (nothing shows while typing)', { hidden: true });
  if (demoPassword.length < 10) throw new Error('The demo password needs at least 10 characters');

  console.log(`\nThis adds the fictional Starlight Nursery team to ${API} (${authConfig.provider === 'supabase' ? 'LIVE server' : 'local server'}).`);
  console.log(`Demo sign-ins end in @${domain}. Nothing is emailed to them. Your own account is not changed.`);
  if (!assumeYes && (await ask('Type YES to continue')).toUpperCase() !== 'YES') {
    console.log('Stopped. Nothing was changed.');
    return;
  }

  // 1. Departments ------------------------------------------------------------------------------
  step('Departments');
  const deptIds = {} as Record<Dept, string>;
  let departments = ok(await call(admin, 'GET', '/admin/departments'), 'departments') as Json[];
  for (const [code, name] of Object.entries(DEPARTMENTS) as [Dept, string][]) {
    const existing = departments.find((d) => d.code === code) ?? (code === 'NC' ? departments.find((d) => /nursery|newborn/i.test(d.name)) : undefined);
    if (existing) {
      deptIds[code] = existing.id;
      console.log(`  ${existing.name}: already there`);
    } else {
      deptIds[code] = ok(await call(admin, 'POST', '/admin/departments', { code, name, timezone: 'Asia/Manila' }), `add ${name}`).id;
      console.log(`  ${name}: added`);
    }
  }
  departments = ok(await call(admin, 'GET', '/admin/departments'), 'departments');
  const nursery = departments.find((d) => d.id === deptIds.NC);
  // The Nursery's own words (Shift endorsement, Head Nurse, Concern…), unless already customised.
  if (!nursery?.experience || !Object.keys(nursery.experience).length) {
    ok(await call(admin, 'PUT', `/admin/departments/${deptIds.NC}/experience`, NEWBORN_EXPERIENCE), 'Nursery wording');
    console.log('  Nursery wording applied');
  }

  // 2. Accounts and duties ----------------------------------------------------------------------
  step('Accounts (password already set, no invitation)');
  let users = ok(await call(admin, 'GET', '/admin/users'), 'users') as Json[];
  const ids = {} as Record<Key, string>;
  for (const p of PEOPLE) {
    const email = emailOf(p.name);
    let user = users.find((u) => u.email?.toLowerCase() === email);
    if (!user) {
      const created = ok(
        await call(admin, 'POST', '/admin/users', { full_name: p.name, email, password: demoPassword, role: p.role, department_id: deptIds[p.dept as Dept], team_id: null, phone: null }),
        `add ${p.name}`,
      );
      user = { id: created.id };
      console.log(`  added   ${p.title.padEnd(30)} ${email}`);
    } else console.log(`  exists  ${p.title.padEnd(30)} ${email}`);
    ids[p.key] = user.id;
    ok(await call(admin, 'PATCH', `/admin/users/${user.id}/job-title`, { job_title: p.title }), `job title ${p.name}`);
  }
  const grants = ok(await call(admin, 'GET', '/admin/access'), 'duties') as Json[];
  for (const p of PEOPLE) {
    for (const cap of p.duties) {
      if (grants.some((g) => g.profile_id === ids[p.key] && g.capability === cap)) continue;
      ok(await call(admin, 'POST', '/admin/access', { profile_id: ids[p.key], capability: cap, department_id: null }), `grant ${cap}`, [409]);
      console.log(`  duty    ${p.name}: ${cap.replace('_', ' ')}`);
    }
  }

  // Sign everyone in once, and turn their email alerts off (fake addresses are never emailed).
  step('Signing in each demo account and turning its email alerts off');
  const tokens = {} as Record<Key, string>;
  for (const p of PEOPLE) {
    try {
      tokens[p.key] = await signIn(emailOf(p.name), demoPassword);
    } catch (e) {
      throw new Error(`${(e as Error).message}\nIf this account was made earlier with another demo password, run again with that password.`);
    }
    ok(await call(tokens[p.key], 'PATCH', '/me/preferences', { notify_email: false, notify_sms: false, phone: null }), `alerts ${p.name}`);
  }
  const as = (k: Key) => tokens[k];

  // 3. Schedule -------------------------------------------------------------------------------------
  step('Shift patterns and the duty schedule');
  const head = as('maria');
  let templates = ok(await call(head, 'GET', '/manager/templates'), 'patterns') as Json[];
  if (!templates.some((t) => t.is_active)) {
    ok(await call(head, 'POST', '/manager/schedule/preset', { preset: 'continuous_24h' }), 'Day/Evening/Night patterns');
    templates = ok(await call(head, 'GET', '/manager/templates'), 'patterns');
    console.log('  Day 06:00–14:00, Evening 14:00–22:00, Night 22:00–06:00');
  }
  const active = templates.filter((t) => t.is_active);
  for (const t of active) if (MIN_STAFF[t.name] !== undefined) ok(await call(head, 'PATCH', `/manager/templates/${t.id}/min-staff`, { min_staff: MIN_STAFF[t.name] }), `minimum ${t.name}`);

  const today = ok(await call(head, 'GET', '/manager/board?from=2026-01-01&to=2026-01-01'), 'board').department.today as string;
  const day = Number(today.slice(8));
  const month = today.slice(0, 8);
  const current = day <= 15 ? { start: `${month}01`, end: `${month}15` } : { start: `${month}16`, end: lastOfMonth(today) };
  const prevMonthLast = addDays(`${month}01`, -1);
  const previous = day <= 15 ? { start: `${prevMonthLast.slice(0, 8)}16`, end: prevMonthLast } : { start: `${month}01`, end: `${month}15` };
  const from = previous.start;
  const to = addDays(today, 13);
  for (const t of active) ok(await call(head, 'POST', `/manager/templates/${t.id}/generate`, { from, to, supervisor_id: null }), `shifts ${t.name}`);
  for (const [key, c] of Object.entries(CREW)) ok(await call(head, 'POST', '/manager/rest-days', { employee_id: ids[key as Key], from, to, weekdays: c!.rest }), `rest days ${key}`);
  let board = ok(await call(head, 'GET', `/manager/board?from=${from}&to=${to}`), 'board');
  let assigned = 0;
  for (const s of board.shifts as Json[]) {
    if (s.status !== 'scheduled' || !s.template_id) continue;
    for (const [key, c] of Object.entries(CREW)) {
      const id = ids[key as Key];
      if (c!.shift !== s.label || c!.rest.includes(isoWeekday(s.shift_date)) || (s.assignees as string[]).includes(id)) continue;
      const r = await call(head, 'POST', `/manager/schedule/${s.id}/assignments`, { employee_id: id });
      if (r.status === 201 || r.status === 200) assigned++;
    }
  }
  board = ok(await call(head, 'GET', `/manager/board?from=${from}&to=${to}`), 'board');
  console.log(`  ${from} to ${to}: ${assigned} new duty assignments, rest days set`);

  // 4. Records and concerns -------------------------------------------------------------------------
  step('Unit records and concerns');
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  if (!(ok(await call(head, 'GET', '/manager/records'), 'records') as Json[]).length) {
    const records = [
      ['policy', 'POL-NC-01', 'Shift endorsement standard for the Nursery', 'Endorse unit readiness, supplies, equipment and pending nursing tasks at every shift change. Use record and request numbers; patient details stay in the approved clinical record, never in the endorsement.', 24 * 30],
      ['quality', 'NC-READY-01', 'Nursery readiness checklist', 'Radiant warmers pre-warmed and checked; neonatal resuscitation cart checked and sealed; suction and oxygen tested at each bassinet station; breastfeeding corner set up. No patient information is included.', 9],
      ['quality', 'COLD-NC-07', 'Vaccine refrigerator temperature log', 'Twice-daily cold-chain log for the Nursery vaccine refrigerator. Acceptable range 2–8 °C. Readings outside the range are reported to the Head Nurse and pharmacy, and the vaccines are moved to the backup refrigerator.', 11],
      ['inventory', 'SUP-NC-028', 'Newborn supply par levels', 'Par levels for the Nursery: newborn screening filter cards 20, infant ID band sets 30, cord care kits 25, diaper packs 40, swaddle blankets 40.', 48],
      ['staffing', 'NC-ROSTER-01', 'Nursing coverage and incoming briefing', 'Incoming briefing covers open unit concerns, the cold-chain log and supply requests. One nurse per shift is assigned to the Nursery readiness checklist.', 7],
    ] as const;
    for (const [record_type, reference_code, title, details, h] of records) {
      ok(await call(head, 'POST', '/manager/records', { record_type, reference_code, title, details, recorded_at: hoursAgo(h) }), `record ${reference_code}`);
    }
    console.log(`  ${records.length} records (policy, checklist, cold-chain log, par levels, coverage)`);
  }
  const issues = ok(await call(head, 'GET', '/issues?scope=all'), 'concerns');
  const issueList: Json[] = Array.isArray(issues) ? issues : issues.items ?? issues.issues ?? [];
  if (!issueList.length) {
    const fridge = ok(await call(head, 'POST', '/issues', {
      title: 'Vaccine refrigerator reading above 8 °C',
      description: 'The Nursery vaccine refrigerator read 8.4 °C at the 12:00 check (range 2–8 °C). Vaccines were moved to the backup refrigerator; pharmacy and the Head Nurse were informed. Recheck at 16:00 and log it in COLD-NC-07.',
      severity: 'high', is_safety: true,
    }), 'concern 1');
    const cards = ok(await call(head, 'POST', '/issues', {
      title: 'Newborn screening filter cards running low',
      description: 'Only 6 cards left against a par level of 20 (SUP-NC-028). A request was sent to the supply office; screening must not be delayed for babies due for collection.',
      severity: 'medium', is_safety: false,
    }), 'concern 2');
    ok(await call(head, 'POST', `/issues/${cards.id}/transition`, { to: 'in_progress', note: 'The supply office confirmed the request; delivery expected tomorrow morning.' }), 'concern 2 progress');
    ok(await call(head, 'POST', `/issues/${fridge.id}/assign`, { assignee_id: ids.juan }), 'assign concern 1');
    // One raised by a staff nurse, waiting for the Head Nurse to verify it.
    ok(await call(as('rosa'), 'POST', '/issues', {
      title: 'ID band printer at the nurses\' station keeps jamming',
      description: 'The infant ID band printer jams every few bands since this morning. Bands are being written by hand as a backup. Biomedical engineering not called yet.',
      severity: 'medium', is_safety: false,
    }), 'concern 3');
    console.log('  3 concerns (one safety concern, one in progress, one waiting for verification)');
  }

  // 5. Leave ------------------------------------------------------------------------------------------
  step('Leave requests');
  if (!(ok(await call(head, 'GET', '/manager/leave?scope=all'), 'leave') as Json[]).length) {
    const types = ok(await call(head, 'GET', '/leave-types'), 'leave types') as Json[];
    const type = (name: string) => types.find((t) => t.name === name)?.id ?? types[0].id;
    const leave = async (who: Key, kind: string, a: number, b: number, reason: string) =>
      ok(await call(as(who), 'POST', '/leave', { leave_type_id: type(kind), start_date: addDays(today, a), end_date: addDays(today, b), reason }), `leave ${who}`).id as string;
    const paolo = await leave('paolo', 'Vacation leave', 4, 4, 'Family event in the province');
    ok(await call(head, 'POST', `/manager/leave/${paolo}/decision`, { decision: 'approved', note: 'Approved. Please hand over the supply count to Rosa.' }), 'approve leave');
    const ben = await leave('ben', 'Vacation leave', 6, 6, 'Personal errand');
    ok(await call(head, 'POST', `/manager/leave/${ben}/decision`, { decision: 'rejected', note: 'Two evening staff are already off that day. Could you take the following week?' }), 'decline leave');
    await leave('leo', 'Sick leave', 2, 2, 'Medical appointment');
    await leave('mae', 'Vacation leave', 8, 9, '');
    console.log('  4 requests: approved, declined and two waiting for the Head Nurse');
  }

  // 6. Endorsements analysed by Mica --------------------------------------------------------------
  step('Shift endorsements');
  const reports = ok(await call(head, 'GET', '/manager/reports?days=30'), 'endorsements') as Json[];
  if (reports.length) console.log('  Endorsements already exist, skipped');
  else {
    const now = Date.now();
    const latestDay = (who: Key, before = Infinity) =>
      (board.shifts as Json[])
        .filter((s) => s.label === 'Day' && s.status === 'scheduled' && Date.parse(s.starts_at) < now && Date.parse(s.starts_at) < before && (s.assignees as string[]).includes(ids[who]))
        .sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at))[0];
    const blank = { completed_work: '', problems: [], unresolved_issues: '', no_unresolved_issues: false, pending_tasks: '', no_pending_tasks: false, operational_concerns: '', handover_notes: '', evidence_refs: '', issue_updates: [] };
    const submit = async (who: Key, shift: Json, reason: string, content: Json) => {
      ok(await call(head, 'POST', `/manager/shifts/${shift.id}/override`, { employee_id: ids[who], minutes: 120, reason }), 'reporting window');
      const { report_id } = ok(await call(as(who), 'POST', `/shifts/${shift.id}/report`), 'start endorsement');
      ok(await call(as(who), 'POST', `/reports/${report_id}/submit`, { content: { ...blank, ...content } }), 'submit endorsement');
      return report_id as string;
    };
    const paoloShift = latestDay('paolo');
    const juanShift = latestDay('juan', paoloShift ? Date.parse(paoloShift.starts_at) : Infinity) ?? latestDay('juan');
    const done: { id: string; approve: boolean }[] = [];
    if (juanShift) {
      done.push({ approve: true, id: await submit('juan', juanShift, 'Endorsement delayed by the end-of-shift supply count', {
        completed_work: 'Prepared the Nursery for the shift: radiant warmers pre-warmed and checked, the neonatal resuscitation cart checked and resealed, and suction and oxygen tested at each bassinet station (NC-READY-01 done). Helped Ana Lim with the 10:00 newborn bathing demonstration for mothers. Restocked diapers, swaddles and cord care kits in rooms 1–4. Logged the vaccine refrigerator at 08:00 and 12:00.',
        unresolved_issues: 'The vaccine refrigerator read 8.4 °C at 12:00 (range 2–8 °C); vaccines are in the backup refrigerator and the Head Nurse knows. The ID band printer at the nurses\' station jams every few bands.',
        pending_tasks: 'Recheck the vaccine refrigerator at 16:00 and log it in COLD-NC-07. Receive the 15:00 diaper and linen delivery and put it away.',
        handover_notes: 'The infant security tag reader at the Nursery door gave one false alarm at 11:20; security checked it and said it is fine, but please watch it.',
        evidence_refs: 'NC-READY-01, COLD-NC-07',
      }) });
    }
    if (paoloShift) {
      done.push({ approve: false, id: await submit('paolo', paoloShift, 'Late endorsement agreed with the Head Nurse', {
        completed_work: 'Finished the noon count of the newborn supply room against the par list (SUP-NC-028). Checked the phototherapy units in rooms 1 and 2 with the Head Nurse; both working. Cleaned and set up the breastfeeding corner. Fixed the loose shelf in the linen store myself, should be okay now.',
        unresolved_issues: 'Newborn screening filter cards are down to 6 against a par of 20. The breast pump in the lactation room has weak suction.',
        pending_tasks: 'Follow up the screening card request with the supply office before the 16:00 cut-off. Ask about a replacement breast pump for the lactation room.',
        handover_notes: 'Ma\'am Reyes from the supply office said the cards should arrive tomorrow morning.',
      }) });
    }
    console.log(`  ${done.length} endorsements submitted; waiting for Mica's analysis (up to 6 minutes)…`);
    const detailOf = async (id: string) => ok(await call(head, 'GET', `/manager/reports/${id}`), 'endorsement');
    for (let waited = 0; waited <= 360; waited += 10) {
      const states = await Promise.all(done.map(async (d) => (await detailOf(d.id)).report.status as string));
      if (states.every((s) => !['submitted', 'processing'].includes(s))) break;
      await sleep(10_000);
    }
    const first = done.find((d) => d.approve);
    if (first) {
      const detail = await detailOf(first.id);
      const run = (detail.runs as Json[]).find((r) => r.status === 'succeeded');
      if (detail.report.status === 'pending_review' && run) {
        const issueByCode = new Map((detail.open_issues as Json[]).map((i) => [i.code, i.id]));
        ok(await call(head, 'POST', `/manager/reports/${first.id}/decision`, {
          decision: 'approved',
          content: {
            summary: run.draft.summary,
            completed_tasks: (run.draft.completed_tasks as Json[]).map((t) => ({ description: String(t.description).slice(0, 500) })),
            unresolved_issues: (run.draft.unresolved_issues as Json[]).map((i) => ({
              title: String(i.title).slice(0, 160), description: String(i.description).slice(0, 1000), severity: i.severity, is_safety_concern: i.is_safety_concern,
              link_issue_id: (i.related_issue_code && issueByCode.get(i.related_issue_code)) || null, initial_status: 'open',
            })).filter((i) => i.title.length >= 3),
            pending_actions: (run.draft.pending_actions as Json[]).map((a) => ({ description: String(a.description).slice(0, 500) })),
            notes_for_incoming: 'Keep the vaccines in the backup refrigerator until the main one reads 2–8 °C on two checks in a row.',
          },
          flag_resolutions: (run.flags as Json[]).map((_f, i) => ({ flag_index: i, resolution: 'accepted_as_unverified', note: 'Checked against the cold-chain log COLD-NC-07 at endorsement.' })),
          note: 'Checked against the Nursery readiness checklist and the cold-chain log.',
        }), 'approve endorsement');
        // The incoming crew reads it.
        await sleep(3_000);
        let read = false;
        for (const [key, c] of Object.entries(CREW)) {
          if (read || c!.shift !== 'Evening') continue;
          const incoming = ok(await call(as(key as Key), 'GET', '/handovers/incoming'), 'incoming') as Json[];
          if (incoming[0]) {
            ok(await call(as(key as Key), 'POST', `/handovers/${incoming[0].delivery_id}/acknowledge`, { note: 'Read at change of shift.' }), 'acknowledge');
            read = true;
          }
        }
        console.log(`  Juan's endorsement approved${read ? ' and read by the incoming Evening crew' : ''}`);
      } else {
        console.log(`  Juan's endorsement is "${detail.report.status}" (Mica did not finish in time); approve it in the app if you like.`);
      }
    }
    if (done.some((d) => !d.approve)) console.log('  Paolo\'s endorsement is waiting for the Head Nurse\'s review (approve it live).');
  }

  // 7. Attendance, DTR and payroll ---------------------------------------------------------------
  step('QR station, pay, attendance, DTR and payroll');
  const nurseryStaff = PEOPLE.filter((p) => p.dept === 'NC' && p.role === 'employee');
  let attendance = ok(await call(head, 'GET', '/manager/attendance'), 'attendance');
  if (!(attendance.stations as Json[]).some((s) => s.is_active)) {
    const st = ok(await call(head, 'POST', '/manager/attendance/stations', { name: 'Nursery station' }), 'QR station');
    const web = (process.env.WEB_URL || (authConfig.provider === 'supabase' ? 'https://silenthandover.vercel.app' : 'http://localhost:5173')).replace(/\/+$/, '');
    console.log(`  QR station made. Open this on the station tablet: ${web}/station/${st.id}#key=${st.key}`);
    console.log('  (Keep that link private. Head Nurse → Attendance → Stations can make a new one any time.)');
  }
  const hr = as('helen');
  let overview = ok(await call(hr, 'GET', '/hr/overview'), 'HR overview');
  const group = overview.pay_groups[0];
  if (!group) throw new Error('No pay group found (HR → Pay groups)');
  for (const p of nurseryStaff) ok(await call(hr, 'POST', '/hr/pay-group-members', { profile_id: ids[p.key], pay_group_id: group.id }), 'pay group');
  for (const p of nurseryStaff) {
    const monthly = /attendant/i.test(p.title) ? 22000 : 36000;
    ok(await call(hr, 'PUT', `/payroll/compensation/${ids[p.key]}`, { monthly_basic: monthly, effective_from: '2026-01-01', note: 'Basic pay per appointment' }), 'monthly pay');
  }
  const periodId: Record<'previous' | 'current', string> = { previous: '', current: '' };
  for (const [name, p] of [['previous', previous], ['current', current]] as const) {
    const existing = (overview.periods as Json[]).find((x) => x.pay_group_id === group.id && x.start_date === p.start);
    periodId[name] = existing?.id ?? ok(await call(hr, 'POST', '/hr/periods', { pay_group_id: group.id, start_date: p.start, end_date: p.end, pay_date: p.end }), 'cutoff').id;
  }
  console.log(`  Pay group, monthly pay, cutoffs ${previous.start}–${previous.end} and ${current.start}–${current.end}`);

  // Duties that ended before the QR station existed are entered from the unit's logbook (the system
  // keeps no attendance record for them otherwise); a few in the current cutoff are a little late.
  attendance = ok(await call(head, 'GET', `/manager/attendance?from=${from}&to=${today}`), 'attendance');
  const punched = new Set((attendance.records as Json[]).filter((r) => r.time_in).map((r) => `${r.shift_id}:${r.profile_id}`));
  let attested = 0;
  let n = 0;
  for (const s of board.shifts as Json[]) {
    if (s.status !== 'scheduled' || Date.parse(s.ends_at) > Date.now()) continue;
    for (const profileId of s.assignees as string[]) {
      if (punched.has(`${s.id}:${profileId}`)) continue;
      const late = s.shift_date >= current.start && ++n % 9 === 0 ? 12 : 0;
      const inAt = new Date(Date.parse(s.starts_at) + late * 60_000).toISOString();
      const a = await call(head, 'POST', '/manager/attendance/attest', { shift_id: s.id, profile_id: profileId, kind: 'in', at: inAt, reason: LABEL });
      const b = await call(head, 'POST', '/manager/attendance/attest', { shift_id: s.id, profile_id: profileId, kind: 'out', at: s.ends_at, reason: LABEL });
      if (a.status < 300 && b.status < 300) attested++;
      else console.log(`  (could not enter ${s.label} ${s.shift_date}: ${a.body?.error?.message ?? b.body?.error?.message})`);
    }
  }
  console.log(`  Time-in/out entered for ${attested} past duties (today's are left for live QR scanning)`);

  // The previous cutoff, end to end: verified, confirmed by staff, certified, locked, payroll prepared.
  overview = ok(await call(hr, 'GET', '/hr/overview'), 'HR overview');
  const prev = (overview.periods as Json[]).find((x) => x.id === periodId.previous);
  const payroll = ok(await call(as('pablo'), 'GET', '/payroll/overview'), 'payroll overview');
  if (prev?.state === 'locked' && (payroll.runs as Json[]).some((r) => r.period_id === periodId.previous)) {
    console.log('  Previous cutoff already locked and its payroll prepared, skipped');
  } else {
    attendance = ok(await call(head, 'GET', `/manager/attendance?from=${previous.start}&to=${previous.end}`), 'attendance');
    for (const x of attendance.exceptions as Json[]) {
      if (x.shift_date && x.shift_date >= previous.start && x.shift_date <= previous.end) {
        await call(head, 'POST', `/manager/attendance/exceptions/${x.id}/resolve`, { note: 'Checked against the attendance logbook' });
      }
    }
    const unverified = (attendance.records as Json[]).filter((r) => r.status === 'present' && !r.verified_at).map((r) => r.id);
    for (let i = 0; i < unverified.length; i += 200) ok(await call(head, 'POST', '/manager/attendance/verify', { record_ids: unverified.slice(i, i + 200) }), 'verify duties');
    if (prev?.state !== 'locked') {
      for (const p of nurseryStaff) {
        const dtr = ok(await call(as(p.key), 'GET', `/dtr/mine/${periodId.previous}`), `DTR ${p.name}`);
        const id = dtr.id ?? dtr.dtr?.id;
        const state = dtr.state ?? dtr.dtr?.state;
        if (id && state === 'draft') ok(await call(as(p.key), 'POST', `/dtr/${id}/confirm`), `confirm DTR ${p.name}`);
      }
      const dtrs = ok(await call(head, 'GET', `/manager/dtr?period_id=${periodId.previous}`), 'unit DTRs');
      for (const d of dtrs.people as Json[]) if (d.state === 'staff_confirmed') ok(await call(head, 'POST', `/manager/dtr/${d.id}/certify`), `certify ${d.full_name}`);
      ok(await call(hr, 'POST', `/hr/periods/${periodId.previous}/lock`), 'lock cutoff');
    }
    const run = ok(await call(as('pablo'), 'POST', '/payroll/runs', { period_id: periodId.previous }), 'prepare payroll');
    ok(await call(as('pablo'), 'POST', `/payroll/runs/${run.id}/submit`), 'submit payroll');
    console.log(`  Cutoff ${previous.start}–${previous.end}: duties verified, DTRs confirmed and certified, locked; payroll waiting for Finance`);
  }

  // Summary ----------------------------------------------------------------------------------------
  console.log('\nDone. Sign in with the demo password you chose:');
  for (const p of PEOPLE) console.log(`  ${p.title.padEnd(30)} ${emailOf(p.name)}`);
  console.log('Your admin account is unchanged. After the presentation: npm run demo:live -- --cleanup');
}

async function runCleanup(admin: string, domain: string) {
  const users = (ok(await call(admin, 'GET', '/admin/users'), 'users') as Json[]).filter((u) => u.email?.toLowerCase().endsWith(`@${domain}`) && u.is_active);
  if (!users.length) {
    console.log(`No active @${domain} accounts.`);
    return;
  }
  console.log(`This deactivates ${users.length} demo accounts (@${domain}) on ${API}. They can no longer sign in.`);
  if (!assumeYes && (await ask('Type YES to continue')).toUpperCase() !== 'YES') return console.log('Stopped. Nothing was changed.');
  for (const u of users) {
    ok(await call(admin, 'PATCH', `/admin/users/${u.id}`, { full_name: u.full_name, role: u.role, department_id: u.department_id ?? null, team_id: u.team_id ?? null, phone: u.phone ?? null, is_active: false }), `deactivate ${u.email}`);
    console.log(`  deactivated ${u.email}`);
  }
  console.log('Done. Their records stay in the history (audit log, schedules) as inactive people.');
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
