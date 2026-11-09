import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adhocShift, setup, type Harness } from './helpers';

/**
 * Attendance -> DTR -> payroll, end to end, with the separation rules:
 * QR station codes, punches, attestation, corrections, overtime, verification, replacements,
 * staff confirmation and Head Nurse certification, HR lock, payroll preparation, independent
 * Finance approval and release, and payslips. Nobody approves their own record.
 */
describe('attendance, DTR and payroll', () => {
  let h: Harness;
  const PASSWORD = 'test-password-123';
  let nc: string;
  let stationId: string;
  let stationKey: string;
  let ninaShift: string;
  let oscarShift: string;
  let periodId: string;
  let runId: string;
  let payGroup: string;
  let today: string;

  async function addPerson(key: string, name: string, role: 'employee' | 'manager', department: string) {
    const email = `${key}@demo.test`;
    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: name, email, password: PASSWORD, role, department_id: department });
    expect(res.status).toBe(201);
    h.ids[key] = (await h.sql<{ id: string }>('select id from public.profiles where email = $1', [email]))[0]!.id;
    await h.loginAs(key, email, PASSWORD);
  }
  const grant = (key: string, capability: string, department: string | null = null) =>
    h.call('admin', 'POST', '/api/admin/access', { profile_id: h.ids[key], capability, department_id: department });
  const shiftTimes = async (id: string) => (await h.sql<{ s: Date; e: Date }>('select starts_at as s, ends_at as e from public.shifts where id = $1', [id]))[0]!;
  const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000).toISOString();
  const record = async (shift: string, key: string) =>
    (await h.sql('select * from public.attendance_records where shift_id = $1 and profile_id = $2', [shift, h.ids[key]]))[0];

  beforeAll(async () => {
    h = await setup();
    nc = (await h.sql<{ id: string }>(`select id from public.departments where code = 'NC'`))[0]!.id;
    const hrDept = await h.call('admin', 'POST', '/api/admin/departments', { code: 'HRD', name: 'Human Resources', timezone: 'Asia/Manila' });
    expect(hrDept.status).toBe(201);
    await addPerson('nina', 'Nina Cruz', 'employee', nc);
    await addPerson('oscar', 'Oscar Lim', 'employee', nc);
    await addPerson('pia', 'Pia Santos', 'employee', nc);
    await addPerson('hr', 'Helen Ramos', 'employee', hrDept.body.id);
    await addPerson('payroll', 'Pablo Reyes', 'employee', hrDept.body.id);
    await addPerson('finance', 'Fiona Tan', 'employee', hrDept.body.id);
    today = (await h.sql<{ d: string }>(`select (now() at time zone 'Asia/Manila')::date::text as d`))[0]!.d;
    payGroup = (await h.sql<{ id: string }>('select id from public.pay_groups limit 1'))[0]!.id;
  });
  afterAll(async () => h?.close());

  it('lets IT grant workforce duties, but never to an IT account', async () => {
    expect((await grant('admin', 'timekeeper')).status).toBe(422);
    expect((await grant('juan', 'nursing_service')).status).toBe(422);
    expect((await h.call('juan', 'POST', '/api/admin/access', { profile_id: h.ids.juan, capability: 'hr_admin', department_id: null })).status).toBe(403);
    for (const [k, cap] of [['hr', 'timekeeper'], ['hr', 'hr_admin'], ['payroll', 'payroll_preparer'], ['finance', 'finance_approver']] as const) {
      expect((await grant(k, cap)).status).toBe(201);
    }
    expect((await grant('hr', 'timekeeper')).status).toBe(409);
    const me = (await h.call('payroll', 'GET', '/api/me')).body;
    expect(me.capabilities).toEqual([{ capability: 'payroll_preparer', department_id: null }]);
  });

  it('records a time-in from the rotating station code, once', async () => {
    const station = await h.call('manager', 'POST', '/api/manager/attendance/stations', { name: 'Nursery station' });
    expect(station.status).toBe(201);
    stationId = station.body.id;
    stationKey = station.body.key;
    expect((await h.call('juan', 'POST', '/api/manager/attendance/stations', { name: 'Mine' })).status).toBe(403);

    expect((await h.call(null, 'GET', `/api/stations/${stationId}/code`, undefined, { 'X-Station-Key': 'wrong-key-wrong-key-wrong-key-000' })).status).toBe(401);
    const shown = await h.call(null, 'GET', `/api/stations/${stationId}/code`, undefined, { 'X-Station-Key': stationKey });
    expect(shown.status).toBe(200);
    expect(shown.body.code).toMatch(/^\d{6}$/);
    expect(shown.body.qr).toBe(`SHQR1:${stationId}:${shown.body.code}`);

    const shift = await adhocShift(h, { startsSql: `now() - interval '30 minutes'`, endsSql: `now() + interval '7 hours'`, employee: 'pia' });
    const wrong = await h.call('pia', 'POST', '/api/attendance/scan', { station_id: stationId, code: shown.body.code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    const scan = await h.call('pia', 'POST', '/api/attendance/scan', { station_id: stationId, code: shown.body.code, event_key: 'qr:test:juan:0001' });
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ kind: 'in', repeat: false });
    // A retry with the same key, or a second scan right away, does not add a punch.
    expect((await h.call('pia', 'POST', '/api/attendance/scan', { station_id: stationId, code: shown.body.code, event_key: 'qr:test:juan:0001' })).body.repeat).toBe(true);
    expect((await h.call('pia', 'POST', '/api/attendance/scan', { station_id: stationId, code: shown.body.code })).body.repeat).toBe(true);
    expect(await h.sql('select 1 from public.attendance_events where profile_id = $1', [h.ids.pia])).toHaveLength(1);
    expect((await record(shift, 'pia'))!.status).toBe('clocked_in');
    // Another unit's staff cannot use this station.
    expect((await h.call('liza', 'POST', '/api/attendance/scan', { station_id: stationId, code: shown.body.code })).status).toBe(403);
    // Punches are evidence: they cannot be edited.
    await expect(h.sql(`update public.attendance_events set captured_at = now() where profile_id = $1`, [h.ids.pia])).rejects.toThrow();
  });

  it('turns attested times into late, overtime and verification items for the Head Nurse', async () => {
    ninaShift = await adhocShift(h, { startsSql: `now() - interval '10 hours'`, endsSql: `now() - interval '2 hours'`, employee: 'nina' });
    const t = await shiftTimes(ninaShift);
    expect((await h.call('nina', 'POST', '/api/manager/attendance/attest', { shift_id: ninaShift, profile_id: h.ids.nina, kind: 'in', at: plus(t.s, 10), reason: 'Station down' })).status).toBe(403);
    expect((await h.call('manager', 'POST', '/api/manager/attendance/attest', { shift_id: ninaShift, profile_id: h.ids.nina, kind: 'in', at: plus(t.s, 10), reason: 'Gloved, station out of reach' })).status).toBe(201);
    expect((await h.call('manager', 'POST', '/api/manager/attendance/attest', { shift_id: ninaShift, profile_id: h.ids.nina, kind: 'out', at: plus(t.e, 45), reason: 'Stayed for an emergency admission' })).status).toBe(201);
    const r = await record(ninaShift, 'nina');
    expect(r).toMatchObject({ status: 'present', late_minutes: 10, overtime_candidate_minutes: 45 });

    const board = (await h.call('manager', 'GET', `/api/manager/attendance?from=${today}&to=${today}`)).body;
    const kinds = board.exceptions.filter((x: any) => x.profile_id === h.ids.nina).map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['late', 'overtime']);
    // Overtime cannot exceed the recorded time; then it is approved as pay.
    expect((await h.call('manager', 'POST', `/api/manager/attendance/records/${r.id}/overtime`, { minutes: 90, treatment: 'pay' })).status).toBe(422);
    expect((await h.call('manager', 'POST', `/api/manager/attendance/records/${r.id}/overtime`, { minutes: 45, treatment: 'pay', note: 'Emergency admission' })).status).toBe(200);
    expect((await h.call('manager', 'POST', '/api/manager/attendance/verify', { record_ids: [r.id] })).body.verified).toBe(1);
    expect((await record(ninaShift, 'nina'))!.verified_at).not.toBeNull();
  });

  it('fixes a missing punch through a correction the Head Nurse approves', async () => {
    oscarShift = await adhocShift(h, { startsSql: `now() - interval '11 hours'`, endsSql: `now() - interval '3 hours'`, employee: 'oscar' });
    const t = await shiftTimes(oscarShift);
    await h.call('manager', 'GET', `/api/manager/attendance?from=${today}&to=${today}`);
    expect((await record(oscarShift, 'oscar'))!.status).toBe('no_show');
    const a = await h.call('oscar', 'POST', '/api/attendance/corrections', { shift_id: oscarShift, kind: 'add_in', at: plus(t.s, 0), reason: 'Phone battery died' });
    const b = await h.call('oscar', 'POST', '/api/attendance/corrections', { shift_id: oscarShift, kind: 'add_out', at: plus(t.e, 0), reason: 'Phone battery died' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await h.call('juan', 'POST', `/api/manager/attendance/corrections/${a.body.id}/decision`, { decision: 'approved' })).status).toBe(403);
    for (const id of [a.body.id, b.body.id]) {
      expect((await h.call('manager', 'POST', `/api/manager/attendance/corrections/${id}/decision`, { decision: 'approved' })).status).toBe(200);
    }
    const r = await record(oscarShift, 'oscar');
    expect(r).toMatchObject({ status: 'present', late_minutes: 0, undertime_minutes: 0 });
    expect((await h.call('manager', 'POST', '/api/manager/attendance/verify', { record_ids: [r.id] })).status).toBe(200);
    // The added punches are marked as corrections, not scans.
    expect((await h.sql('select source from public.attendance_events where profile_id = $1', [h.ids.oscar])).map((e: any) => e.source)).toEqual(['correction', 'correction']);
  });

  it('keeps who covered whom when a shift is reassigned', async () => {
    const future = await adhocShift(h, { startsSql: `now() + interval '30 hours'`, endsSql: `now() + interval '38 hours'`, employee: 'carla' });
    const res = await h.call('manager', 'POST', '/api/manager/attendance/replace', { shift_id: future, original_id: h.ids.carla, replacement_id: h.ids.daniel, reason: 'Carla called in sick', emergency: true });
    expect(res.status).toBe(201);
    const versions = await h.sql('select profile_id, expected, change_kind from public.duty_expectations where shift_id = $1 order by version', [future]);
    const named = versions.map((v: any) => [v.profile_id === h.ids.carla ? 'carla' : 'daniel', v.expected, v.change_kind]);
    expect(named.sort((p: any, q: any) => String(p).localeCompare(String(q)))).toEqual([
      ['carla', false, 'removed'],
      ['carla', true, 'assigned'],
      ['daniel', true, 'assigned'],
    ]);
    expect(await h.sql('select 1 from public.coverage_changes where shift_id = $1 and emergency', [future])).toHaveLength(1);
  });

  it('certifies DTRs only after the staff member confirms and nothing is left open, then HR locks the period', async () => {
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const p = await h.call('hr', 'POST', '/api/hr/periods', { pay_group_id: payGroup, start_date: yesterday, end_date: today, pay_date: today });
    expect(p.status).toBe(201);
    periodId = p.body.id;
    for (const k of ['nina', 'oscar']) {
      expect((await h.call('hr', 'POST', '/api/hr/pay-group-members', { profile_id: h.ids[k], pay_group_id: payGroup })).status).toBe(200);
    }
    const nina = (await h.call('nina', 'GET', `/api/dtr/mine/${periodId}`)).body;
    expect(nina).toMatchObject({ state: 'draft', blocking_items: 0 });
    expect(nina.totals).toMatchObject({ late_minutes: 10, overtime_pay_minutes: 45, duties: 1 });
    // Not confirmed by Nina yet.
    expect((await h.call('manager', 'POST', `/api/manager/dtr/${nina.id}/certify`)).status).toBe(409);
    expect((await h.call('oscar', 'POST', `/api/dtr/${nina.id}/confirm`)).status).toBe(404);
    expect((await h.call('nina', 'POST', `/api/dtr/${nina.id}/confirm`)).status).toBe(200);
    expect((await h.call('manager', 'POST', `/api/manager/dtr/${nina.id}/certify`)).status).toBe(200);

    expect((await h.call('juan', 'POST', `/api/hr/periods/${periodId}/lock`)).status).toBe(403);
    const early = await h.call('hr', 'POST', `/api/hr/periods/${periodId}/lock`);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain('not certified');

    const oscar = (await h.call('oscar', 'GET', `/api/dtr/mine/${periodId}`)).body;
    await h.call('oscar', 'POST', `/api/dtr/${oscar.id}/confirm`);
    expect((await h.call('manager', 'POST', `/api/manager/dtr/${oscar.id}/certify`)).status).toBe(200);
    expect((await h.call('hr', 'POST', `/api/hr/periods/${periodId}/lock`)).status).toBe(200);
    // Locked: corrections now go through adjustments.
    const t = await shiftTimes(ninaShift);
    expect((await h.call('nina', 'POST', '/api/attendance/corrections', { shift_id: ninaShift, kind: 'add_out', at: plus(t.e, 0), reason: 'Late correction' })).status).toBe(409);
  });

  it('prepares payroll from certified totals only, and Finance (not the preparer) approves and releases it', async () => {
    expect((await h.call('payroll', 'PUT', `/api/payroll/compensation/${h.ids.nina}`, { monthly_basic: 35200, effective_from: '2026-01-01' })).status).toBe(403);
    expect((await h.call('hr', 'PUT', `/api/payroll/compensation/${h.ids.nina}`, { monthly_basic: 35200, effective_from: '2026-01-01' })).status).toBe(200);
    expect((await h.call('hr', 'PUT', `/api/payroll/compensation/${h.ids.oscar}`, { monthly_basic: 28160, effective_from: '2026-01-01' })).status).toBe(200);

    // Payroll sees totals, not punches.
    expect(await h.sqlAs('payroll', 'select * from public.attendance_events')).toEqual([]);
    expect(await h.sqlAs('payroll', 'select * from public.attendance_records')).toEqual([]);
    expect(await h.sqlAs('nina', 'select * from public.compensation_settings')).toEqual([]);

    const run = await h.call('payroll', 'POST', '/api/payroll/runs', { period_id: periodId });
    expect(run.status).toBe(201);
    runId = run.body.id;
    const detail = (await h.call('payroll', 'GET', `/api/payroll/runs/${runId}`)).body;
    const ninaPay = detail.people.find((x: any) => x.profile_id === h.ids.nina);
    // Sample rules: hourly = 35,200 / 22 / 8 = 200. Basic semi-monthly 17,600; overtime 0.75 h x 250;
    // tardiness 10 min x 3.3333.
    const byCode = Object.fromEntries(ninaPay.lines.map((l: any) => [l.code, Number(l.amount)]));
    expect(byCode.basic).toBe(17600);
    expect(byCode.overtime).toBe(187.5);
    expect(byCode.tardiness).toBe(33.33);

    expect((await h.call('payroll', 'POST', `/api/finance/runs/${runId}/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await h.call('payroll', 'POST', `/api/payroll/runs/${runId}/submit`)).status).toBe(200);
    // Even with Finance access, the preparer cannot approve their own run.
    expect((await grant('payroll', 'finance_approver')).status).toBe(201);
    const self = await h.call('payroll', 'POST', `/api/finance/runs/${runId}/decision`, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toContain('prepared');

    expect((await h.call('nina', 'GET', '/api/payslips')).body).toEqual([]);
    expect((await h.call('finance', 'POST', `/api/finance/runs/${runId}/decision`, { decision: 'approved' })).status).toBe(200);
    expect((await h.call('finance', 'POST', `/api/finance/runs/${runId}/release`)).status).toBe(200);
    const slips = (await h.call('nina', 'GET', '/api/payslips')).body;
    expect(slips).toHaveLength(1);
    expect(Number(slips[0].net)).toBeCloseTo(17600 + 187.5 - 33.33 + (Number(byCode.night_differential) || 0), 2);
    // Nobody else's lines are visible to Nina.
    expect((await h.sqlAs('nina', 'select distinct profile_id from public.payroll_lines')).map((x: any) => x.profile_id)).toEqual([h.ids.nina]);
  });

  it('keeps IT out of attendance and pay data', async () => {
    expect((await h.call('admin', 'GET', '/api/manager/attendance')).status).toBe(403);
    expect((await h.call('admin', 'GET', '/api/payroll/overview')).status).toBe(403);
    expect(await h.sqlAs('admin', 'select * from public.attendance_records')).toEqual([]);
    expect(await h.sqlAs('admin', 'select * from public.payroll_lines')).toEqual([]);
  });

  it('gives Mica role-scoped attendance facts, with no pay amounts', async () => {
    const titles = (r: any) => r.body.facts.map((g: any) => g.title);
    const staff = await h.call('nina', 'POST', '/api/assistant/help', { message: 'Which punch is missing?', page: 'attendance' });
    expect(staff.status).toBe(200);
    expect(titles(staff)).toEqual(expect.arrayContaining(['Your attendance items to fix', 'Your latest DTR']));
    const head = await h.call('manager', 'POST', '/api/assistant/help', { message: 'Compare scheduled and verified coverage', page: 'team_attendance' });
    expect(titles(head).some((t: string) => t.startsWith('Scheduled and verified coverage'))).toBe(true);
    const pay = await h.call('payroll', 'POST', '/api/assistant/help', { message: 'Which DTRs are missing?', page: 'payroll' });
    expect(titles(pay)).toEqual(['Certified DTRs per cutoff', 'Payroll runs']);
    expect(JSON.stringify(pay.body.facts)).not.toMatch(/17,?600|35,?200|187\.5/);
    // Without the duty, the payroll page gives no payroll facts.
    const other = await h.call('juan', 'POST', '/api/assistant/help', { message: 'Which DTRs are missing?', page: 'payroll' });
    expect(JSON.stringify(other.body.facts ?? [])).not.toContain('Payroll runs');
  });
});
