import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, type AppEnv } from '../http/context';
import type { Queryable } from '../db/types';
import { boardFor, employeeSchedule } from '../services/schedule';

/**
 * Scheduling and leave: the employee's own schedule and leave requests, the supervisor's
 * department board and leave decisions, and the administrator's leave types and read-only board.
 * Every rule (who may decide, conflicts, coverage) is enforced by the database functions; these
 * routes validate input and shape the data for the pages.
 */
const date = z.iso.date();
const Range = z
  .object({ from: date, to: date })
  .refine((r) => r.to >= r.from, 'The end date must be on or after the start date')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 92, 'Choose a range of up to three months');

export function leaveRoutes() {
  const r = new Hono<AppEnv>();

  // ---- Everyone with a department --------------------------------------------------
  r.get('/leave-types', async (c) =>
    c.json(await asUser(c, (q) => q.query('select id, name, description, requires_reason, max_days, is_active from public.leave_types order by sort_order, name'))),
  );

  r.get('/leave', async (c) => {
    requireRole(c, 'employee', 'manager');
    const rows = await asUser(c, (q) =>
      q.query(
        `select r.id, r.leave_type_id, t.name as leave_type, r.start_date::text as start_date, r.end_date::text as end_date,
                r.end_date - r.start_date + 1 as days, r.reason, r.status, r.decision_note, r.decided_at, r.created_at, r.cancelled_at,
                d.full_name as decided_by_name
           from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
           left join public.profiles d on d.id = r.decided_by
          where r.employee_id = auth.uid() order by r.start_date desc limit 100`,
      ),
    );
    return c.json(rows);
  });

  r.post('/leave', async (c) => {
    requireRole(c, 'employee', 'manager');
    const b = await parseBody(
      c,
      z.strictObject({ leave_type_id: z.uuid(), start_date: date, end_date: date, reason: z.string().trim().max(1000).default('') }),
    );
    const id = await asUser(c, async (q) =>
      (await q.query<{ id: string }>('select app.request_leave($1, $2::date, $3::date, $4) as id', [b.leave_type_id, b.start_date, b.end_date, b.reason]))[0]!.id,
    );
    return c.json({ id }, 201);
  });

  r.post('/leave/:id/cancel', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const { note } = await parseBody(c, z.strictObject({ note: z.string().trim().max(1000).default('') }));
    await asUser(c, (q) => q.query('select app.cancel_leave($1, $2)', [id, note]));
    return c.json({ ok: true });
  });

  // The employee's own schedule: shifts, rest days, leave.
  r.get('/employee/schedule', async (c) => {
    requireRole(c, 'employee');
    const { from, to } = parseQuery(c, Range);
    return c.json(await asUser(c, (q) => employeeSchedule(q, from, to)));
  });

  // ---- Supervisors --------------------------------------------------------------
  r.get('/manager/board', async (c) => {
    requireRole(c, 'manager');
    const { from, to } = parseQuery(c, Range);
    return c.json(await asUser(c, async (q) => boardFor(q, (await q.query<{ d: string }>('select app.my_department() as d'))[0]!.d, from, to)));
  });

  // The supervisor's team: everyone active in the department, with today's status, the next shift,
  // this week's shifts and leave. A list only: accounts are created and changed by the administrator.
  r.get('/manager/team', async (c) => {
    requireRole(c, 'manager');
    return c.json(
      await asUser(c, async (q) => {
        const departmentId = (await q.query<{ d: string }>('select app.my_department() as d'))[0]!.d;
        const [{ today }] = (await q.query<{ today: string }>(`select (now() at time zone timezone)::date::text as today from public.departments where id = $1`, [departmentId])) as [{ today: string }];
        const offset = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
        // From yesterday, so a night shift that started yesterday still counts as on duty now.
        const board = await boardFor(q, departmentId, offset(-1), offset(6));
        const pending = await q.query<{ employee_id: string; n: number }>(
          `select employee_id, count(*)::int as n from public.leave_requests where department_id = $1 and status = 'pending' group by employee_id`,
          [departmentId],
        );
        const now = Date.now();
        return {
          today,
          members: board.employees.map((e) => {
            const all = board.shifts.filter((s) => s.status === 'scheduled' && s.assignees.includes(e.id));
            const mine = all.filter((s) => s.shift_date >= today);
            const onNow = all.find((s) => Date.parse(s.starts_at) <= now && Date.parse(s.ends_at) > now);
            const next = all.find((s) => Date.parse(s.starts_at) > now);
            const leave = board.leave.find((l) => l.employee_id === e.id && l.status === 'approved' && today >= l.start_date && today <= l.end_date);
            const mark = board.marks.find((m) => m.employee_id === e.id && m.day === today);
            const status = onNow ? 'on_duty' : leave ? 'on_leave' : mark ? mark.kind : mine.some((s) => s.shift_date === today) ? 'scheduled_today' : 'off_today';
            return {
              id: e.id, full_name: e.full_name, job_title: e.job_title, photo_version: e.photo_version, status,
              next_shift: next ? { label: next.label, starts_at: next.starts_at, ends_at: next.ends_at } : null,
              shifts_this_week: mine.length,
              upcoming_leave: board.leave.filter((l) => l.employee_id === e.id && l.status === 'approved' && l.end_date >= today).map((l) => ({ leave_type: l.leave_type, start_date: l.start_date, end_date: l.end_date })),
              pending_leave: pending.find((p) => p.employee_id === e.id)?.n ?? 0,
            };
          }),
        };
      }),
    );
  });

  r.get('/manager/leave', async (c) => {
    requireRole(c, 'manager');
    const { scope } = parseQuery(c, z.object({ scope: z.enum(['pending', 'all']).default('pending') }));
    const rows = await asUser(c, (q) =>
      q.query(
        `select r.id, r.employee_id, p.full_name as employee_name, p.job_title, r.leave_type_id, t.name as leave_type,
                r.start_date::text as start_date, r.end_date::text as end_date, r.end_date - r.start_date + 1 as days,
                r.reason, r.status, r.decision_note, r.decided_at, r.created_at, d.full_name as decided_by_name,
                app.can_decide_leave(r.id) as can_decide
           from public.leave_requests r
           join public.profiles p on p.id = r.employee_id
           join public.leave_types t on t.id = r.leave_type_id
           left join public.profiles d on d.id = r.decided_by
          where r.department_id = app.my_department() and ($1 = 'all' or r.status = 'pending')
          order by (r.status = 'pending') desc, r.start_date ${scope === 'pending' ? 'asc' : 'desc'} limit 200`,
        [scope],
      ),
    );
    return c.json(rows);
  });

  r.get('/manager/leave/:id/impact', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    return c.json(await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.leave_impact($1) as r', [id]))[0]!.r));
  });

  const Decision = z.strictObject({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(1000).default('') });
  r.post('/manager/leave/:id/decision', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    const b = await parseBody(c, Decision);
    return c.json(await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.decide_leave($1, $2, $3) as r', [id, b.decision, b.note]))[0]!.r));
  });

  r.post('/manager/leave/:id/cancel', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    const { note } = await parseBody(c, z.strictObject({ note: z.string().trim().min(3).max(1000) }));
    await asUser(c, (q) => q.query('select app.cancel_leave($1, $2)', [id, note]));
    return c.json({ ok: true });
  });

  r.put('/manager/day-marks', async (c) => {
    requireRole(c, 'manager');
    const b = await parseBody(
      c,
      z.strictObject({ employee_id: z.uuid(), day: date, kind: z.enum(['rest_day', 'day_off']).nullable(), note: z.string().trim().max(200).default('') }),
    );
    await asUser(c, (q) => q.query('select app.set_day_mark($1, $2::date, $3, $4)', [b.employee_id, b.day, b.kind, b.note]));
    return c.json({ ok: true });
  });

  r.post('/manager/rest-days', async (c) => {
    requireRole(c, 'manager');
    const b = await parseBody(
      c,
      z.strictObject({ employee_id: z.uuid(), from: date, to: date, weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7) }),
    );
    const added = await asUser(c, async (q) =>
      (await q.query<{ n: number }>('select app.set_rest_days($1, $2::date, $3::date, $4::smallint[]) as n', [b.employee_id, b.from, b.to, b.weekdays]))[0]!.n,
    );
    return c.json({ added });
  });

  const MinStaff = z.strictObject({ min_staff: z.number().int().min(0).max(50) });
  r.patch('/manager/templates/:id/min-staff', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    const { min_staff } = await parseBody(c, MinStaff);
    await asUser(c, (q) => q.query('select app.set_pattern_min_staff($1, $2)', [id, min_staff]));
    return c.json({ ok: true });
  });
  r.patch('/manager/schedule/:id/min-staff', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    const { min_staff } = await parseBody(c, MinStaff);
    await asUser(c, (q) => q.query('select app.set_shift_min_staff($1, $2)', [id, min_staff]));
    return c.json({ ok: true });
  });

  // ---- Administrators -----------------------------------------------------------
  // Configuration only (leave types, job titles). Schedules and leave stay with the department.

  const LeaveType = z.strictObject({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    requires_reason: z.boolean().default(false),
    max_days: z.number().int().min(1).max(365).nullable().default(null),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(1000).default(0),
  });
  const saveType = (id: string | null, b: z.infer<typeof LeaveType>) => (q: Queryable) =>
    q.query<{ id: string }>('select app.admin_upsert_leave_type($1, $2, $3, $4, $5, $6, $7) as id', [
      id, b.name, b.description, b.requires_reason, b.max_days, b.is_active, b.sort_order,
    ]);
  r.post('/admin/leave-types', async (c) => {
    requireRole(c, 'admin');
    const b = await parseBody(c, LeaveType);
    return c.json({ id: (await asUser(c, saveType(null, b)))[0]!.id }, 201);
  });
  r.patch('/admin/leave-types/:id', async (c) => {
    requireRole(c, 'admin');
    const id = idParam(c);
    const b = await parseBody(c, LeaveType);
    await asUser(c, saveType(id, b));
    return c.json({ ok: true });
  });

  r.patch('/admin/users/:id/job-title', async (c) => {
    requireRole(c, 'admin');
    const id = idParam(c);
    const { job_title } = await parseBody(c, z.strictObject({ job_title: z.string().trim().max(80).nullable() }));
    if (job_title && job_title.length < 2) throw new ApiError(422, 'validation', 'Use at least 2 characters', { job_title: 'Too short' });
    await asUser(c, (q) => q.query('select app.admin_set_job_title($1, $2)', [id, job_title]));
    return c.json({ ok: true });
  });

  return r;
}
