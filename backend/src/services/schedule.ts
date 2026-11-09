import { ApiError } from '../http/errors';
import type { Queryable } from '../db/types';

/**
 * Schedule queries shared by the routes and Mica: the department board (shifts, rest days, leave
 * and conflicts) and a staff member's own schedule. Read-only; workflow rules stay in the database.
 */
export interface BoardShift {
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
export interface Mark {
  employee_id: string;
  day: string;
  kind: 'rest_day' | 'day_off';
  note: string;
}
export interface LeaveRow {
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
