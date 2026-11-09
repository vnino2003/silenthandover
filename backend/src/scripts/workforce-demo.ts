/**
 * npm run demo:workforce — sets up the attendance, DTR and payroll demonstration on a running API,
 * through the same API and checks as the pages (everything is audited):
 *   1. IT (admin) adds three fictional accounts in a "Human Resources" department and grants their
 *      duties: HR timekeeper + HR administrator, Payroll personnel, Finance approver.
 *   2. The Head Nurse sets up a QR attendance station and gets its one-time setup link.
 *   3. HR puts the unit's staff in the sample pay group, opens the current cutoff period and sets
 *      SAMPLE monthly pay (clearly labelled; not real salary grades).
 *   4. The Head Nurse attests time-in and time-out for duties of the last two days that have no
 *      punches, with the reason "Demo data", so the board, DTRs and payroll have something to show.
 *      Today's duties are left for live QR scanning.
 *
 * Usage (values are never printed back):
 *   API_URL=http://localhost:8787 ADMIN_EMAIL=... ADMIN_PASSWORD=... HEAD_EMAIL=... HEAD_PASSWORD=... \
 *   NEW_PASSWORD=... EMAIL_DOMAIN=starlight.test npm run demo:workforce
 * Run it once; running it again skips what already exists.
 */
const API = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k}`);
  return v;
};

async function call<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
const ok = <T>(r: { status: number; body: T }, what: string, accept: number[] = []) => {
  if (r.status >= 300 && !accept.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
async function login(email: string, password: string) {
  return ok(await call<{ token: string }>(null, 'POST', '/auth/login', { email, password }), `sign in ${email}`).token;
}

async function main() {
  const domain = process.env.EMAIL_DOMAIN ?? 'starlight.test';
  const newPassword = env('NEW_PASSWORD');
  const admin = await login(env('ADMIN_EMAIL'), env('ADMIN_PASSWORD'));
  const head = await login(env('HEAD_EMAIL'), env('HEAD_PASSWORD'));

  // 1. Accounts and duties.
  const departments = ok(await call<any[]>(admin, 'GET', '/admin/departments'), 'departments');
  let hrDept = departments.find((d) => d.code === 'HR');
  if (!hrDept) hrDept = ok(await call(admin, 'POST', '/admin/departments', { code: 'HR', name: 'Human Resources', timezone: 'Asia/Manila' }), 'HR department');
  const people = [
    { key: 'hr', name: 'Helen Ramos', title: 'HR Officer (timekeeping)', duties: ['timekeeper', 'hr_admin'] },
    { key: 'payroll', name: 'Pablo Reyes', title: 'Payroll Officer', duties: ['payroll_preparer'] },
    { key: 'finance', name: 'Fiona Tan', title: 'Accountant (Finance)', duties: ['finance_approver'] },
  ];
  const users = ok(await call<any[]>(admin, 'GET', '/admin/users'), 'users');
  const tokens: Record<string, string> = {};
  for (const p of people) {
    const email = `${p.name.toLowerCase().replace(/\s+/g, '.')}@${domain}`;
    let user = users.find((u) => u.email === email);
    if (!user) {
      ok(await call(admin, 'POST', '/admin/users', { full_name: p.name, email, password: newPassword, role: 'employee', department_id: hrDept.id }), `add ${p.name}`);
      user = ok(await call<any[]>(admin, 'GET', '/admin/users'), 'users').find((u) => u.email === email);
      console.log(`Added ${p.name} (${email})`);
    }
    await call(admin, 'PATCH', `/admin/users/${user.id}/job-title`, { job_title: p.title });
    for (const cap of p.duties) ok(await call(admin, 'POST', '/admin/access', { profile_id: user.id, capability: cap, department_id: null }), `grant ${cap}`, [409]);
    tokens[p.key] = await login(email, newPassword);
  }

  // 2. QR station.
  const board = ok(await call<any>(head, 'GET', '/manager/attendance'), 'attendance board');
  if (!board.stations.some((s: any) => s.is_active)) {
    const st = ok(await call<{ id: string; key: string }>(head, 'POST', '/manager/attendance/stations', { name: 'Nursery station' }), 'station');
    console.log(`QR station created. Open on the station tablet (keep this link private): <web address>/station/${st.id}#key=${st.key}`);
  } else console.log('A QR station already exists (use "New setup link" on Attendance → Stations to open it on a tablet).');

  // 3. Pay group, cutoff, sample pay.
  const hr = ok(await call<any>(tokens.hr!, 'GET', '/hr/overview'), 'HR overview');
  const group = hr.pay_groups[0];
  const unitStaff: { id: string; full_name: string; job_title: string | null }[] = board.staff;
  for (const s of unitStaff) ok(await call(tokens.hr!, 'POST', '/hr/pay-group-members', { profile_id: s.id, pay_group_id: group.id }), 'pay group');
  const today = board.today as string;
  const first = `${today.slice(0, 8)}${Number(today.slice(8)) <= 15 ? '01' : '16'}`;
  const last = Number(today.slice(8)) <= 15 ? `${today.slice(0, 8)}15` : new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  if (!hr.periods.some((p: any) => p.start_date === first)) {
    ok(await call(tokens.hr!, 'POST', '/hr/periods', { pay_group_id: group.id, start_date: first, end_date: last, pay_date: last }), 'cutoff period');
    console.log(`Cutoff period ${first} to ${last} opened.`);
  }
  // SAMPLE monthly basic pay by title (demo values, not official salary grades).
  for (const s of unitStaff) {
    const monthly = /attendant/i.test(s.job_title ?? '') ? 22000 : 36000;
    ok(await call(tokens.hr!, 'PUT', `/payroll/compensation/${s.id}`, { monthly_basic: monthly, effective_from: '2026-01-01', note: 'Sample pay for the demo' }), 'compensation');
  }

  // 4. Demo attendance for the last two days (attested, labelled), so DTRs have content.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  const recent = ok(await call<any>(head, 'GET', `/manager/attendance?from=${from}&to=${today}`), 'recent attendance');
  let attested = 0;
  for (const r of recent.records) {
    if (Date.parse(r.scheduled_end) > Date.now() || r.time_in || r.status === 'excused') continue;
    const reason = 'Demo data: sample attendance for the presentation';
    const a = await call(head, 'POST', '/manager/attendance/attest', { shift_id: r.shift_id, profile_id: r.profile_id, kind: 'in', at: r.scheduled_start, reason });
    const b = await call(head, 'POST', '/manager/attendance/attest', { shift_id: r.shift_id, profile_id: r.profile_id, kind: 'out', at: r.scheduled_end, reason });
    if (a.status < 300 && b.status < 300) attested++;
  }
  console.log(`Sample attendance attested for ${attested} past duties (today's duties are left for QR scanning).`);
  console.log('Done. Sign in as Helen (HR), Pablo (Payroll) or Fiona (Finance) with the password you chose.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
