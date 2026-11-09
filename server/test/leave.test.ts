import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Harness } from './helpers';

/**
 * Scheduling and leave. The seeded week (from tomorrow): Juan on Morning, Ana and Ben on Afternoon.
 * Maria is the only supervisor of the Newborn Care department; Rico supervises Facilities.
 */
describe('scheduling and leave', () => {
  let h: Harness;
  let day: (offset: number) => string;
  let sickLeave: string;
  let vacation: string;
  let juanLeave: string;

  const kinds = async (who: string) => (await h.call(who, 'GET', '/api/notifications')).body.items.map((n: any) => n.kind);
  const juanShiftOn = async (d: string) =>
    (await h.sql<{ id: string }>(
      `select s.id from public.shifts s join public.shift_assignments a on a.shift_id = s.id and a.removed_at is null
        where a.employee_id = $1 and s.shift_date = $2::date and s.status = 'scheduled'`,
      [h.ids.juan, d],
    ))[0]?.id;

  beforeAll(async () => {
    h = await setup();
    const today = (await h.sql<{ today: string }>(`select (now() at time zone 'Asia/Manila')::date::text as today`))[0]!.today;
    day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const types = (await h.call('juan', 'GET', '/api/leave-types')).body;
    sickLeave = types.find((t: any) => t.name === 'Sick leave').id;
    vacation = types.find((t: any) => t.name === 'Vacation leave').id;
  });
  afterAll(async () => h?.close());

  it('validates a leave request', async () => {
    expect((await h.call('juan', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(-1), end_date: day(0) })).status).toBe(422);
    expect((await h.call('juan', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(3), end_date: day(2) })).status).toBe(422);
    // Sick leave needs a reason; the admin has set it up that way.
    const noReason = await h.call('juan', 'POST', '/api/leave', { leave_type_id: sickLeave, start_date: day(2), end_date: day(2) });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toContain('reason');
    expect((await h.call('admin', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(2), end_date: day(2) })).status).toBe(403);
  });

  it('records a pending request and tells the supervisor, without touching the schedule', async () => {
    const res = await h.call('juan', 'POST', '/api/leave', { leave_type_id: sickLeave, start_date: day(2), end_date: day(3), reason: 'Dental procedure and recovery' });
    expect(res.status).toBe(201);
    juanLeave = res.body.id;
    expect(await kinds('manager')).toContain('leave_requested');
    // Pending is not approved: Juan is still on his shifts.
    expect(await juanShiftOn(day(2))).toBeTruthy();
    const mine = (await h.call('juan', 'GET', '/api/leave')).body;
    expect(mine[0]).toMatchObject({ id: juanLeave, status: 'pending', days: 2, leave_type: 'Sick leave' });
    // Overlapping dates are refused.
    expect((await h.call('juan', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(3), end_date: day(4) })).status).toBe(409);
  });

  it('keeps the request (and its reason) between the person and their supervisors', async () => {
    expect((await h.call('ana', 'GET', '/api/leave')).body).toEqual([]);
    expect(await h.sqlAs('ana', 'select * from public.leave_requests')).toEqual([]);
    expect(await h.sqlAs('admin', 'select * from public.leave_requests')).toEqual([]);
    expect((await h.call('facmanager', 'GET', '/api/manager/leave')).body).toEqual([]);
    const queue = (await h.call('manager', 'GET', '/api/manager/leave')).body;
    expect(queue[0]).toMatchObject({ employee_name: 'Juan Dela Cruz', reason: 'Dental procedure and recovery', can_decide: true });
  });

  it('only lets a supervisor of the department decide, and never the requester', async () => {
    expect((await h.call('juan', 'POST', `/api/manager/leave/${juanLeave}/decision`, { decision: 'approved' })).status).toBe(403);
    await expect(h.sqlAs('juan', `select app.decide_leave($1, 'approved', '')`, [juanLeave])).rejects.toThrow(/SH:forbidden/);
    expect((await h.call('facmanager', 'POST', `/api/manager/leave/${juanLeave}/decision`, { decision: 'approved' })).status).toBe(403);
    // The administrator has no part in leave: no route, and the database refuses too.
    expect((await h.call('admin', 'POST', `/api/admin/leave/${juanLeave}/decision`, { decision: 'approved' })).status).toBe(404);
    await expect(h.sqlAs('admin', `select app.decide_leave($1, 'approved', '')`, [juanLeave])).rejects.toThrow(/SH:forbidden/);
    expect(await h.sqlAs('admin', 'select id from public.leave_requests')).toEqual([]);
  });

  it('shows the supervisor what approving would do', async () => {
    const impact = (await h.call('manager', 'GET', `/api/manager/leave/${juanLeave}/impact`)).body;
    expect(impact.shifts.map((s: any) => [s.label, s.shift_date, s.assigned, s.assigned_after])).toEqual([
      ['Morning', day(2), 1, 0],
      ['Morning', day(3), 1, 0],
    ]);
  });

  it('on approval takes the person off those shifts, tells them, and flags the gap', async () => {
    const res = await h.call('manager', 'POST', `/api/manager/leave/${juanLeave}/decision`, { decision: 'approved', note: 'Get well soon' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', removed_from_shifts: 2 });
    expect(res.body.understaffed).toHaveLength(2);
    expect(await juanShiftOn(day(2))).toBeUndefined();
    expect(await kinds('juan')).toContain('leave_approved');
    expect(await kinds('manager')).toContain('staffing_gap');
    // Nobody can put him back on a shift while he is on approved leave.
    const morning = (await h.sql<{ id: string }>(`select id from public.shifts where label = 'Morning' and shift_date = $1::date`, [day(2)]))[0]!.id;
    const again = await h.call('manager', 'POST', `/api/manager/schedule/${morning}/assignments`, { employee_id: h.ids.juan });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('approved leave');
    // Decided once only.
    expect((await h.call('manager', 'POST', `/api/manager/leave/${juanLeave}/decision`, { decision: 'rejected', note: 'Changed my mind' })).status).toBe(409);
  });

  it('shows approved leave on the employee’s schedule and the department board', async () => {
    const mine = (await h.call('juan', 'GET', `/api/employee/schedule?from=${day(0)}&to=${day(6)}`)).body;
    expect(mine.leave).toEqual([expect.objectContaining({ status: 'approved', leave_type: 'Sick leave', start_date: day(2), end_date: day(3) })]);
    expect(mine.shifts.map((s: any) => s.shift_date)).not.toContain(day(2));
    const board = (await h.call('manager', 'GET', `/api/manager/board?from=${day(0)}&to=${day(6)}`)).body;
    expect(board.leave.find((l: any) => l.id === juanLeave)).toMatchObject({ status: 'approved', leave_type: 'Sick leave' });
    expect(JSON.stringify(board.leave)).not.toContain('Dental');
    expect(board.conflicts.filter((c: any) => c.kind === 'understaffed').map((c: any) => c.day)).toEqual(expect.arrayContaining([day(2), day(3)]));
    expect((await h.call('juan', 'GET', `/api/manager/board?from=${day(0)}&to=${day(6)}`)).status).toBe(403);
  });

  it('requires a reason to reject, and tells the employee', async () => {
    const req = await h.call('ana', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(5), end_date: day(5) });
    expect(req.status).toBe(201);
    expect((await h.call('manager', 'POST', `/api/manager/leave/${req.body.id}/decision`, { decision: 'rejected' })).status).toBe(422);
    expect((await h.call('manager', 'POST', `/api/manager/leave/${req.body.id}/decision`, { decision: 'rejected', note: 'Two others are already off that day' })).status).toBe(200);
    expect(await kinds('ana')).toContain('leave_rejected');
    expect((await h.call('ana', 'GET', '/api/leave')).body[0]).toMatchObject({ status: 'rejected', decision_note: 'Two others are already off that day' });
  });

  it('lets the employee cancel only while pending; the supervisor can cancel approved leave', async () => {
    const req = await h.call('ben', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(6), end_date: day(6) });
    expect((await h.call('ben', 'POST', `/api/leave/${req.body.id}/cancel`, {})).status).toBe(200);
    expect((await h.call('ben', 'GET', '/api/leave')).body[0]).toMatchObject({ status: 'cancelled' });
    expect((await h.call('juan', 'POST', `/api/leave/${juanLeave}/cancel`, {})).status).toBe(409);
    expect((await h.call('manager', 'POST', `/api/manager/leave/${juanLeave}/cancel`, { note: 'Procedure was rescheduled' })).status).toBe(200);
    expect(await kinds('juan')).toContain('leave_changed');
  });

  it('refuses a supervisor’s own leave when no other supervisor of the department can decide it', async () => {
    const req = await h.call('manager', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(4), end_date: day(4) });
    expect(req.status).toBe(409);
    expect(req.body.error.message).toContain('No other Head Nurse in your department can approve your leave');
    expect(await kinds('admin')).not.toContain('leave_requested');
  });

  it('lets the supervisor set rest days, and warns when assigning on one', async () => {
    expect((await h.call('juan', 'PUT', '/api/manager/day-marks', { employee_id: h.ids.ana, day: day(4), kind: 'rest_day' })).status).toBe(403);
    expect((await h.call('manager', 'PUT', '/api/manager/day-marks', { employee_id: h.ids.juan, day: day(5), kind: 'rest_day', note: 'Weekly rest' })).status).toBe(200);
    const weekly = await h.call('manager', 'POST', '/api/manager/rest-days', { employee_id: h.ids.ana, from: day(7), to: day(20), weekdays: [7] });
    expect(weekly.body.added).toBe(2);
    const mine = (await h.call('juan', 'GET', `/api/employee/schedule?from=${day(0)}&to=${day(6)}`)).body;
    expect(mine.marks).toEqual([{ day: day(5), kind: 'rest_day', note: 'Weekly rest' }]);
    // Juan is already on Morning that day: the board lists it as a conflict.
    const board = (await h.call('manager', 'GET', `/api/manager/board?from=${day(0)}&to=${day(6)}`)).body;
    expect(board.conflicts.some((c: any) => c.kind === 'rest_day' && c.day === day(5))).toBe(true);
    // Assigning on a rest day is allowed but comes with a warning.
    const afternoon = (await h.sql<{ id: string }>(`select id from public.shifts where label = 'Afternoon' and shift_date = $1::date`, [day(5)]))[0]!.id;
    await h.call('manager', 'DELETE', `/api/manager/schedule/${(await juanShiftOn(day(5)))!}/assignments/${h.ids.juan}`);
    const res = await h.call('manager', 'POST', `/api/manager/schedule/${afternoon}/assignments`, { employee_id: h.ids.juan });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['Juan Dela Cruz has a rest day then']);
  });

  it('tells people when they are removed from a shift or it is cancelled', async () => {
    expect(await kinds('juan')).toContain('shift_removed');
    const afternoon = (await h.sql<{ id: string; supervisor_id: string | null }>(`select id, supervisor_id from public.shifts where label = 'Afternoon' and shift_date = $1::date`, [day(6)]))[0]!;
    expect((await h.call('manager', 'PATCH', `/api/manager/schedule/${afternoon.id}`, { supervisor_id: afternoon.supervisor_id, status: 'cancelled' })).status).toBe(200);
    expect(await kinds('ana')).toContain('shift_cancelled');
    expect(await kinds('ben')).toContain('shift_cancelled');
  });

  it('reminds people before their shift, once', async () => {
    await h.sql(`update app_settings set value = '48' where key = 'shift_reminder_hours'`);
    const first = await h.call('admin', 'POST', '/api/admin/tick');
    expect(first.body.shift_reminders).toBeGreaterThan(0);
    expect(await kinds('ana')).toContain('shift_reminder');
    const second = await h.call('admin', 'POST', '/api/admin/tick');
    expect(second.body.shift_reminders).toBe(0);
  });

  it('lets supervisors set minimum staff, which drives coverage', async () => {
    const templates = (await h.call('manager', 'GET', '/api/manager/templates')).body;
    const afternoon = templates.find((t: any) => t.name === 'Afternoon');
    expect((await h.call('manager', 'PATCH', `/api/manager/templates/${afternoon.id}/min-staff`, { min_staff: 3 })).status).toBe(200);
    const board = (await h.call('manager', 'GET', `/api/manager/board?from=${day(1)}&to=${day(1)}`)).body;
    const shift = board.shifts.find((s: any) => s.label === 'Afternoon');
    expect(shift.min_staff).toBe(3);
    expect(board.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'understaffed', text: 'Afternoon: 2 of 3 staff' })]));
    expect((await h.call('juan', 'PATCH', `/api/manager/templates/${afternoon.id}/min-staff`, { min_staff: 1 })).status).toBe(403);
  });

  it('gives administrators the leave types, job titles and a read-only board', async () => {
    expect((await h.call('manager', 'POST', '/api/admin/leave-types', { name: 'Study leave' })).status).toBe(403);
    const created = await h.call('admin', 'POST', '/api/admin/leave-types', { name: 'Study leave', requires_reason: true, max_days: 5 });
    expect(created.status).toBe(201);
    expect((await h.call('admin', 'POST', '/api/admin/leave-types', { name: 'Study leave' })).status).toBe(409);
    const tooLong = await h.call('juan', 'POST', '/api/leave', { leave_type_id: created.body.id, start_date: day(8), end_date: day(14), reason: 'Board exam review' });
    expect(tooLong.status).toBe(422);
    expect((await h.call('admin', 'PATCH', `/api/admin/users/${h.ids.ana}/job-title`, { job_title: 'Staff nurse' })).status).toBe(200);
    const board = (await h.call('manager', 'GET', `/api/manager/board?from=${day(0)}&to=${day(6)}`)).body;
    expect(board.employees.find((e: any) => e.id === h.ids.ana)).toMatchObject({ job_title: 'Staff nurse' });
    expect(board.leave.every((l: any) => !('reason' in l))).toBe(true);
    // Schedules are the department's: the administrator cannot read them.
    const [dept] = await h.sql<{ id: string }>(`select department_id as id from public.profiles where id = $1`, [h.ids.ana]);
    expect((await h.call('admin', 'GET', `/api/admin/board?department_id=${dept!.id}&from=${day(0)}&to=${day(6)}`)).status).toBe(404);
    expect(await h.sqlAs('admin', 'select id from public.shifts')).toEqual([]);
    expect(await h.sqlAs('admin', 'select employee_id from public.schedule_day_marks')).toEqual([]);
  });

  it('shows the supervisor their whole team with today’s status and next shift', async () => {
    const team = await h.call('manager', 'GET', '/api/manager/team');
    expect(team.status).toBe(200);
    expect(team.body.members.map((m: any) => m.full_name)).toContain('Ana Lim');
    expect(team.body.members.every((m: any) => !('email' in m))).toBe(true);
    for (const who of ['juan', 'admin', 'facmanager']) {
      const r = await h.call(who, 'GET', '/api/manager/team');
      if (who === 'facmanager') expect(r.body.members.map((m: any) => m.full_name)).not.toContain('Ana Lim');
      else expect(r.status).toBe(403);
    }
  });
});
