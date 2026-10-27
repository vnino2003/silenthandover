import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, type AppEnv } from '../http/context';
import type { Queryable } from '../db/types';

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

interface BoardShift {
  id: string;
  label: string;
  template_id: string | null;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: 'scheduled' | 'cancelled';
  min_staff: number;
  assignees: string[];
}
interface Mark {
  employee_id: string;
  day: string;
  kind: 'rest_day' | 'day_off';
  note: string;
}
interface LeaveRow {
  id: string;
  employee_id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  status: 'pending' | 'approved';
}

const inLeave = (l: { start_date: string; end_date: string }, day: string) => day >= l.start_date && day <= l.end_date;

/** Everything the department board shows for a date range, plus the conflicts worth attention. */
export async function boardFor(q: Queryable, departmentId: string, from: string, to: string) {
  const [department] = await q.query<{ id: string; name: string; timezone: string; today: string }>(
    `select id, name, timezone, (now() at time zone timezone)::date::text as today from public.departments where id = $1`,
    [departmentId],
  );
  if (!department) throw new ApiError(404, 'not_found', 'Department not found');
  const employees = await q.query<{ id: string; full_name: string; job_title: string | null; photo_version: number | null }>(
    `select p.id, p.full_name, p.job_title,
            (select floor(extract(epoch from ph.updated_at))::bigint from public.profile_photos ph where ph.profile_id = p.id) as photo_version
       from public.profiles p where p.department_id = $1 and p.role = 'employee' and p.is_active order by p.full_name`,
    [departmentId],
  );
  const patterns = await q.query(
    `select id, name, to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time, min_staff, weekdays
       from public.shift_templates where department_id = $1 and is_active order by start_time`,
    [departmentId],
  );
  const shifts = await q.query<BoardShift>(
    `select s.id, s.label, s.template_id, s.shift_date::text as shift_date, s.starts_at, s.ends_at, s.status, s.min_staff,
            coalesce((select jsonb_agg(a.employee_id order by a.created_at) from public.shift_assignments a
                       where a.shift_id = s.id and a.removed_at is null), '[]'::jsonb) as assignees
       from public.shifts s where s.department_id = $1 and s.shift_date between $2::date and $3::date
      order by s.starts_at`,
    [departmentId, from, to],
  );
  const marks = await q.query<Mark>(
    `select employee_id, day::text as day, kind, note from public.schedule_day_marks
      where department_id = $1 and day between $2::date and $3::date`,
    [departmentId, from, to],
  );
  const leave = await q.query<LeaveRow>(
    `select id, employee_id, leave_type, start_date::text as start_date, end_date::text as end_date, status
       from app.leave_calendar($1, $2::date, $3::date)`,
    [departmentId, from, to],
  );

  // Conflicts: understaffed shifts, pending leave that would take someone off a shift, and
  // people working on a day marked as rest. Past days are left out: nothing can be done there.
  const name = new Map(employees.map((e) => [e.id, e.full_name]));
  const conflicts: { kind: 'understaffed' | 'pending_leave' | 'rest_day'; shift_id: string | null; day: string; employee_id: string | null; text: string }[] = [];
  for (const s of shifts) {
    if (s.status !== 'scheduled' || s.shift_date < department.today) continue;
    if (s.min_staff > 0 && s.assignees.length < s.min_staff) {
      conflicts.push({ kind: 'understaffed', shift_id: s.id, day: s.shift_date, employee_id: null, text: `${s.label}: ${s.assignees.length} of ${s.min_staff} staff` });
    }
    for (const emp of s.assignees) {
      if (leave.some((l) => l.status === 'pending' && l.employee_id === emp && inLeave(l, s.shift_date))) {
        conflicts.push({ kind: 'pending_leave', shift_id: s.id, day: s.shift_date, employee_id: emp, text: `${name.get(emp) ?? 'Someone'} has pending leave but is on ${s.label}` });
      }
      if (marks.some((m) => m.employee_id === emp && m.day === s.shift_date)) {
        conflicts.push({ kind: 'rest_day', shift_id: s.id, day: s.shift_date, employee_id: emp, text: `${name.get(emp) ?? 'Someone'} is on ${s.label} on a rest day` });
      }
    }
  }
  conflicts.sort((a, b) => a.day.localeCompare(b.day));
  return { department, employees, patterns, shifts, marks, leave, conflicts };
}

/** The signed-in employee's own shifts, rest days and leave (row-level security keeps it to them). */
export async function employeeSchedule(q: Queryable, from: string, to: string) {
  const [{ today, timezone }] = (await q.query<{ today: string; timezone: string }>(
    `select (now() at time zone d.timezone)::date::text as today, d.timezone from public.departments d where d.id = app.my_department()`,
  )) as [{ today: string; timezone: string }];
  const shifts = await q.query<{id:string;label:string;shift_date:string;starts_at:string;ends_at:string;timezone:string;status:string;crew_size:number}>(
    `select s.id, s.label, s.shift_date::text as shift_date, s.starts_at, s.ends_at, s.timezone, s.status,
            (select count(*)::int from public.shift_assignments x where x.shift_id = s.id and x.removed_at is null) as crew_size
       from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.employee_id = auth.uid() and a.removed_at is null and s.status = 'scheduled'
        and s.shift_date between $1::date and $2::date
      order by s.starts_at`,
    [from, to],
  );
  const next = await q.query<{id:string;label:string;shift_date:string;starts_at:string;ends_at:string;timezone:string}>(
    `select s.id, s.label, s.shift_date::text as shift_date, s.starts_at, s.ends_at, s.timezone
       from public.shift_assignments a join public.shifts s on s.id = a.shift_id
      where a.employee_id = auth.uid() and a.removed_at is null and s.status = 'scheduled' and s.ends_at > now()
      order by s.starts_at limit 1`,
  );
  const marks = await q.query<{day:string;kind:string;note:string}>(
    `select day::text as day, kind, note from public.schedule_day_marks where employee_id = auth.uid() and day between $1::date and $2::date order by day`,
    [from, to],
  );
  const leave = await q.query<{id:string;leave_type:string;start_date:string;end_date:string;status:string}>(
    `select r.id, t.name as leave_type, r.start_date::text as start_date, r.end_date::text as end_date, r.status
       from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
      where r.employee_id = auth.uid() and r.status in ('pending', 'approved')
        and daterange(r.start_date, r.end_date, '[]') && daterange($1::date, $2::date, '[]')
      order by r.start_date`,
    [from, to],
  );
  return { today, timezone, next_shift:next[0] ?? null, shifts, marks, leave };
}

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
  r.get('/admin/board', async (c) => {
    requireRole(c, 'admin');
    const q0 = parseQuery(c, z.object({ department_id: z.uuid(), from: date, to: date }));
    const { from, to } = Range.parse({ from: q0.from, to: q0.to });
    return c.json(await asUser(c, (q) => boardFor(q, q0.department_id, from, to)));
  });

  r.get('/admin/leave', async (c) => {
    requireRole(c, 'admin');
    return c.json(await asUser(c, (q) => q.query(`select *, start_date::text as start_date, end_date::text as end_date, end_date - start_date + 1 as days from app.admin_leave_queue()`)));
  });
  r.post('/admin/leave/:id/decision', async (c) => {
    requireRole(c, 'admin');
    const id = idParam(c);
    const b = await parseBody(c, Decision);
    return c.json(await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.decide_leave($1, $2, $3) as r', [id, b.decision, b.note]))[0]!.r));
  });

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
