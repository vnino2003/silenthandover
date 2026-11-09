import { FLAG_LABELS, ISSUE_STATUS_LABELS, REPORT_STATUS_LABELS, type AssistantPageContext, type FlagType, type IssueStatus, type MicaFactGroup, type ReportStatus } from '@sh/shared';
import type { Queryable } from '../db/types';
import { asUser, svc, type Ctx } from '../http/context';
import { boardFor, employeeSchedule } from '../services/schedule';
import { reidentifyDeep, type RosterEntry } from './sanitize';

/**
 * The records Mica may use to answer, read with the signed-in user's own permissions (the same
 * row-level security as the pages), so a question can never reach data the user can't open.
 * Employees get their own records, supervisors their department, administrators organization-wide
 * counts only (no report contents, no leave reasons — as on their pages). Leave reasons are never
 * included for anyone: they are often medical.
 */

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const span = (a: string, b: string) => (a === b ? day(a) : `${day(a)} – ${day(b)}`);
const time = (at: string | Date, tz: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LEAVE_STATUS: Record<string, string> = { pending: 'Pending (not approved yet)', approved: 'Approved', rejected: 'Declined', cancelled: 'Cancelled' };

interface Shift { id: string; label: string; shift_date: string; starts_at: string; ends_at: string; timezone: string }

async function departmentToday(q: Queryable) {
  const [row] = await q.query<{ today: string; timezone: string }>(
    `select (now() at time zone d.timezone)::date::text as today, d.timezone from public.departments d where d.id = app.my_department()`,
  );
  return row ?? null;
}

function todayGroup(today: string): MicaFactGroup {
  return { title: 'Today', items: [{ label: 'Date', value: `${day(today)} (${today})` }] };
}

/** The next seven days of the signed-in person's own schedule. */
async function ownWeek(q: Queryable, today: string): Promise<MicaFactGroup[]> {
  const s = (await employeeSchedule(q, today, addDays(today, 6))) as {
    next_shift: Shift | null;
    shifts: Shift[];
    marks: { day: string; kind: string }[];
    leave: { leave_type: string; start_date: string; end_date: string; status: string }[];
  };
  const items = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(today, i);
    const shifts = s.shifts.filter((x) => x.shift_date === d);
    const leave = s.leave.find((l) => d >= l.start_date && d <= l.end_date);
    const mark = s.marks.find((m) => m.day === d);
    const label = `${day(d)}${i === 0 ? ' (today)' : ''}`;
    if (leave?.status === 'approved') return { label, value: `On leave (${leave.leave_type})`, tone: 'ok' as const };
    const work = shifts.map((x) => `${x.label} ${time(x.starts_at, x.timezone)}–${time(x.ends_at, x.timezone)}`).join(', ');
    if (leave) return { label, value: `${work ? `${work}; ` : ''}pending leave (${leave.leave_type}), not approved yet`, tone: 'warn' as const };
    if (work) return { label, value: work };
    if (mark) return { label, value: mark.kind === 'rest_day' ? 'Rest day' : 'Day off', tone: 'neutral' as const };
    return { label, value: 'Not scheduled', tone: 'neutral' as const };
  });
  const n = s.next_shift;
  return [
    {
      title: 'Your next duty shift',
      items: n ? [{ label: n.label, value: `${day(n.shift_date)}, ${time(n.starts_at, n.timezone)}–${time(n.ends_at, n.timezone)}`, link: '/schedule' }] : [],
      empty: 'No upcoming shift is assigned to you.',
    },
    { title: 'Your next 7 days', items },
  ];
}

async function ownLeave(q: Queryable): Promise<MicaFactGroup[]> {
  const requests = await q.query<{ leave_type: string; start_date: string; end_date: string; days: number; status: string }>(
    `select t.name as leave_type, r.start_date::text as start_date, r.end_date::text as end_date, r.end_date - r.start_date + 1 as days, r.status
       from public.leave_requests r join public.leave_types t on t.id = r.leave_type_id
      where r.employee_id = auth.uid() order by r.start_date desc limit 10`,
  );
  const types = await q.query<{ name: string; requires_reason: boolean; max_days: number | null }>(
    'select name, requires_reason, max_days from public.leave_types where is_active order by sort_order, name',
  );
  const [notice] = await q.query<{ v: unknown }>(`select value as v from public.app_settings where key = 'leave_min_notice_days'`);
  const noticeDays = Number(notice?.v ?? 0);
  return [
    {
      title: 'Your leave requests',
      items: requests.map((r) => ({
        label: `${r.leave_type}, ${span(r.start_date, r.end_date)}`,
        value: `${plural(r.days, 'day')} · ${LEAVE_STATUS[r.status] ?? r.status}`,
        tone: r.status === 'approved' ? ('ok' as const) : r.status === 'pending' ? ('warn' as const) : ('neutral' as const),
        link: '/leave',
      })),
      empty: 'You have no leave requests yet.',
    },
    {
      title: 'Leave you can request',
      items: [
        ...types.map((t) => ({ label: t.name, value: `${t.requires_reason ? 'Reason required' : 'Reason optional'}${t.max_days ? ` · up to ${plural(t.max_days, 'day')} per request` : ''}` })),
        { label: 'Notice', value: noticeDays > 0 ? `Request at least ${plural(noticeDays, 'day')} ahead` : 'No minimum notice' },
      ],
    },
  ];
}

async function ownReports(q: Queryable): Promise<MicaFactGroup> {
  const rows = await q.query<{ reference_code: string; status: ReportStatus; label: string; shift_date: string; id: string }>(
    `select r.id, r.reference_code, r.status, s.label, s.shift_date::text as shift_date
       from public.shift_reports r join public.shifts s on s.id = r.shift_id
      where r.employee_id = auth.uid() order by s.starts_at desc limit 8`,
  );
  return {
    title: 'Your recent shift endorsements',
    items: rows.map((r) => ({ label: `${r.reference_code} (${r.label}, ${day(r.shift_date)})`, value: REPORT_STATUS_LABELS[r.status], link: `/reports/${r.id}` })),
    empty: 'You have no shift endorsements yet.',
  };
}

async function departmentIssues(q: Queryable): Promise<MicaFactGroup> {
  const rows = await q.query<{ code: string; title: string; status: IssueStatus; is_safety: boolean; severity: string }>(
    `select code, title, status, is_safety, severity from public.operational_issues
      where department_id = app.my_department() and status in ('reported','pending_verification','open','in_progress','resolution_submitted')
      order by is_safety desc, last_activity_at desc limit 15`,
  );
  return {
    title: 'Open concerns in the unit',
    items: rows.map((i) => ({
      label: `${i.code} ${i.title}`,
      value: `${ISSUE_STATUS_LABELS[i.status]} · ${i.severity}${i.is_safety ? ' · safety' : ''}`,
      tone: i.is_safety ? ('bad' as const) : undefined,
    })),
    empty: 'No open concerns.',
  };
}

async function employeeFacts(c: Ctx, page: AssistantPageContext): Promise<MicaFactGroup[]> {
  return asUser(c, async (q) => {
    const d = await departmentToday(q);
    if (!d) return [];
    if (page === 'leave') return [todayGroup(d.today), ...(await ownLeave(q)), ...(await ownWeek(q, d.today)).slice(1)];
    if (page === 'reports' || page === 'report') return [await ownReports(q)];
    if (page === 'issues' || page === 'issue') return [await departmentIssues(q)];
    return [todayGroup(d.today), ...(await ownWeek(q, d.today))];
  });
}

async function departmentWeek(q: Queryable, departmentId: string, today: string): Promise<MicaFactGroup[]> {
  const b = await boardFor(q, departmentId, today, addDays(today, 6));
  const name = new Map(b.employees.map((e) => [e.id, e.full_name]));
  const away = [
    ...b.leave.filter((l) => l.status === 'approved' && today >= l.start_date && today <= l.end_date).map((l) => ({ label: name.get(l.employee_id) ?? 'Someone', value: `On leave (${l.leave_type})` })),
    ...b.marks.filter((m) => m.day === today).map((m) => ({ label: name.get(m.employee_id) ?? 'Someone', value: m.kind === 'rest_day' ? 'Rest day' : 'Day off' })),
  ];
  return [
    {
      title: 'Needs attention in the next 7 days',
      items: b.conflicts.slice(0, 20).map((x) => ({
        label: day(x.day),
        value: x.text,
        tone: x.kind === 'understaffed' ? ('bad' as const) : ('warn' as const),
        link: '/manager/schedule',
      })),
      empty: 'No understaffed shifts, pending-leave clashes or rest-day assignments in the next 7 days.',
    },
    { title: 'Away today', items: away, empty: 'Nobody is on leave, resting or off today.' },
  ];
}

async function pendingLeaveWithImpact(q: Queryable): Promise<MicaFactGroup> {
  const rows = await q.query<{ id: string; employee_name: string; leave_type: string; start_date: string; end_date: string; days: number }>(
    `select r.id, p.full_name as employee_name, t.name as leave_type, r.start_date::text as start_date, r.end_date::text as end_date,
            r.end_date - r.start_date + 1 as days
       from public.leave_requests r join public.profiles p on p.id = r.employee_id join public.leave_types t on t.id = r.leave_type_id
      where r.department_id = app.my_department() and r.status = 'pending' and app.can_decide_leave(r.id)
      order by r.start_date limit 10`,
  );
  const items = [];
  for (const r of rows) {
    const [{ i }] = (await q.query<{ i: { shifts: { label: string; shift_date: string; min_staff: number; assigned_after: number }[] } }>(
      'select app.leave_impact($1) as i',
      [r.id],
    )) as [{ i: { shifts: { label: string; shift_date: string; min_staff: number; assigned_after: number }[] } }];
    const short = i.shifts.filter((s) => s.min_staff > 0 && s.assigned_after < s.min_staff);
    const effect = !i.shifts.length
      ? 'not on any shift in those days'
      : short.length
        ? `approving leaves ${short.map((s) => `${s.label} on ${day(s.shift_date)} at ${s.assigned_after} of ${s.min_staff}`).join('; ')}`
        : `on ${plural(i.shifts.length, 'shift')}; coverage stays at or above the minimum`;
    items.push({ label: `${r.employee_name}, ${r.leave_type}`, value: `${span(r.start_date, r.end_date)} (${plural(r.days, 'day')}): ${effect}`, tone: short.length ? ('bad' as const) : undefined, link: '/manager/leave' });
  }
  return { title: 'Pending leave you can decide', items, empty: 'No pending leave requests.' };
}

async function reviewFacts(c: Ctx, q: Queryable, reportId: string | undefined): Promise<MicaFactGroup[]> {
  if (!reportId) {
    const rows = await q.query<{ reference_code: string; status: ReportStatus; employee_name: string; label: string; flag_count: number | null; has_safety: boolean | null }>(
      `select r.reference_code, r.status, p.full_name as employee_name, s.label, run.flag_count, run.has_safety
         from public.shift_reports r join public.shifts s on s.id = r.shift_id join public.profiles p on p.id = r.employee_id
         left join lateral (select jsonb_array_length(x.flags) as flag_count,
                                   exists (select 1 from jsonb_array_elements(x.flags) f where f ->> 'type' = 'safety_concern') as has_safety
                              from public.ai_analysis_runs x where x.report_id = r.id and x.revision_no = r.current_revision and x.status = 'succeeded'
                             order by x.created_at desc limit 1) run on true
        where r.department_id = app.my_department() and r.status in ('submitted','processing','pending_review','revision_requested')
        order by (r.status = 'pending_review') desc, run.has_safety desc nulls last, r.last_submitted_at limit 15`,
    );
    return [{
      title: 'Endorsements for approval',
      items: rows.map((r) => ({
        label: `${r.reference_code} (${r.employee_name}, ${r.label})`,
        value: `${REPORT_STATUS_LABELS[r.status]}${r.flag_count ? ` · ${plural(r.flag_count, 'flag')}` : ''}${r.has_safety ? ' · safety concern' : ''}`,
        tone: r.has_safety ? ('bad' as const) : undefined,
      })),
      empty: 'No endorsements are waiting for approval.',
    }];
  }
  const [report] = await q.query<{ id: string; reference_code: string; status: ReportStatus; employee_name: string; current_revision: number }>(
    `select r.id, r.reference_code, r.status, p.full_name as employee_name, r.current_revision
       from public.shift_reports r join public.profiles p on p.id = r.employee_id where r.id = $1 and app.is_manager_of(r.department_id)`,
    [reportId],
  );
  if (!report) return [];
  const [run] = await q.query<{ draft: { summary?: string } | null; flags: { type: FlagType; detail: string }[] | null; is_simulated: boolean }>(
    `select draft, flags, is_simulated from public.ai_analysis_runs
      where report_id = $1 and revision_no = $2 and status = 'succeeded' order by created_at desc limit 1`,
    [report.id, report.current_revision],
  );
  // The stored draft uses pseudonyms; this supervisor may see the names (access proven above).
  const [input] = await svc(c).db.asService((s) =>
    s.query<{ name_mapping: Record<string, string> }>('select name_mapping from internal.analysis_inputs where report_id = $1 and revision_no = $2', [report.id, report.current_revision]),
  );
  const { draft, flags } = reidentifyDeep({ draft: run?.draft ?? null, flags: run?.flags ?? [] }, input?.name_mapping ?? {});
  return [
    {
      title: `Endorsement ${report.reference_code}`,
      items: [
        { label: 'From', value: report.employee_name },
        { label: 'Status', value: REPORT_STATUS_LABELS[report.status] },
        { label: "Mica's draft summary", value: draft?.summary ? draft.summary.replace(/^\[Simulated draft[^\]]*\]\s*/, '') : 'No draft yet (analysis pending or failed)' },
      ],
    },
    {
      title: 'Verification flags to decide',
      items: flags.map((f) => ({ label: FLAG_LABELS[f.type] ?? f.type, value: f.detail, tone: f.type === 'safety_concern' || f.type === 'possible_prompt_injection' ? ('bad' as const) : ('warn' as const) })),
      empty: 'No verification flags on this draft.',
    },
  ];
}

async function managerFacts(c: Ctx, page: AssistantPageContext, entityId?: string): Promise<MicaFactGroup[]> {
  return asUser(c, async (q) => {
    const departmentId = c.get('profile').department_id;
    const d = await departmentToday(q);
    if (!departmentId || !d) return [];
    if (page === 'review') return reviewFacts(c, q, entityId);
    if (page === 'leave_requests') return [todayGroup(d.today), await pendingLeaveWithImpact(q), ...(await departmentWeek(q, departmentId, d.today))];
    if (page === 'leave') return [todayGroup(d.today), ...(await ownLeave(q))];
    if (page === 'issues' || page === 'issue') return [await departmentIssues(q)];
    return [todayGroup(d.today), ...(await departmentWeek(q, departmentId, d.today))];
  });
}

/**
 * Organization-wide counts of reports, AI runs and safety concerns. Service access, but only
 * aggregates leave it (the admin pages' rule). Schedules and leave are not the administrator's.
 */
async function adminFacts(c: Ctx): Promise<MicaFactGroup[]> {
  const rows = await svc(c).db.asService((q) =>
    q.query<{ name: string; pending_review: number; processing: number; failed_runs: number; open_safety: number }>(
      `select d.name,
              (select count(*)::int from public.shift_reports r where r.department_id = d.id and r.status = 'pending_review') as pending_review,
              (select count(*)::int from public.shift_reports r where r.department_id = d.id and r.status in ('submitted','processing')) as processing,
              (select count(*)::int from public.ai_analysis_runs x join public.shift_reports r on r.id = x.report_id
                where r.department_id = d.id and x.status in ('failed','invalid_output') and x.created_at > now() - interval '7 days') as failed_runs,
              (select count(*)::int from public.operational_issues i where i.department_id = d.id and i.is_safety
                and i.status in ('reported','pending_verification','open','in_progress','resolution_submitted')) as open_safety
         from public.departments d order by d.name`,
    ),
  );
  const ai = await svc(c).aiSettings.view();
  return [
    {
      title: 'Departments and units',
      items: rows.map((r) => ({
        label: r.name,
        value: [
          `${r.pending_review} pending review`,
          `${r.processing} being prepared`,
          `${r.failed_runs} failed AI runs (7 days)`,
          `${r.open_safety} open safety concerns`,
        ].join(' · '),
        tone: r.open_safety || r.failed_runs ? ('warn' as const) : undefined,
      })),
      empty: 'No departments yet.',
    },
    {
      title: 'Waiting for you',
      items: [
        { label: "Mica's AI", value: ai.provider === 'simulator' || !ai.has_key ? 'Not connected (practice mode)' : `${ai.provider}, ${ai.model ?? ai.resolved_model ?? 'newest available model'}`, link: '/admin' },
      ],
    },
  ];
}

// ---- Attendance, DTR and payroll facts --------------------------------------------------------
// Deterministic queries with the user's own permissions. They state their period and whether the
// figures are provisional or certified. No salary amounts, raw punch evidence, device data or leave
// reasons are included.
const EXCEPTION_LABEL: Record<string, string> = {
  missing_in: 'Missing time-in', missing_out: 'Missing time-out', late: 'Late', undertime: 'Left early', overtime: 'Overtime to decide',
  possible_absence: 'No time-in (possible absence)', unscheduled: 'Punch with no duty', duplicate: 'Repeated time-in', pending_leave: 'Leave not yet decided',
};

async function ownAttendance(q: Queryable, today: string): Promise<MicaFactGroup[]> {
  const open = await q.query<{ kind: string; label: string | null; shift_date: string | null }>(
    `select x.kind, s.label, s.shift_date::text as shift_date from public.attendance_exceptions x left join public.shifts s on s.id = x.shift_id
      where x.profile_id = auth.uid() and x.state = 'open' order by x.created_at desc limit 10`,
  );
  const recent = await q.query<{ status: string; n: number }>(
    `select r.status, count(*)::int as n from public.attendance_records r join public.shifts s on s.id = r.shift_id
      where r.profile_id = auth.uid() and s.shift_date between $1::date - 14 and $1::date group by r.status`,
    [today],
  );
  const dtr = await q.query<{ start_date: string; end_date: string; state: string; blocking_items: number }>(
    `select c.start_date::text as start_date, c.end_date::text as end_date, d.state, d.blocking_items
       from public.dtr_versions d join public.cutoff_periods c on c.id = d.period_id
      where d.profile_id = auth.uid() and d.state <> 'superseded' order by c.start_date desc, d.version desc limit 1`,
  );
  const STATUS: Record<string, string> = { present: 'present', clocked_in: 'clocked in', incomplete: 'incomplete', no_show: 'no time-in', absent: 'absent', excused: 'on leave', scheduled: 'upcoming' };
  return [
    {
      title: 'Your attendance items to fix',
      items: open.map((x) => ({ label: EXCEPTION_LABEL[x.kind] ?? x.kind, value: x.shift_date ? `${x.label ?? 'Duty'}, ${day(x.shift_date)}` : 'No matching duty', tone: 'warn' as const, link: '/attendance' })),
      empty: 'Nothing to fix. Every recorded duty has its time-in and time-out.',
    },
    {
      title: `Your duties, last 14 days (to ${day(today)}, provisional until certified)`,
      items: recent.map((r) => ({ label: STATUS[r.status] ?? r.status, value: plural(r.n, 'duty', 'duties') })),
      empty: 'No duties recorded in the last 14 days.',
    },
    {
      title: 'Your latest DTR',
      items: dtr.map((d) => ({
        label: span(d.start_date, d.end_date),
        value: d.state === 'certified' ? 'Certified' : d.state === 'staff_confirmed' ? 'Confirmed by you, waiting for certification' : `Draft${d.blocking_items ? ` · ${plural(d.blocking_items, 'item')} to settle first` : ' · ready for you to confirm'}`,
        tone: d.state === 'certified' ? ('ok' as const) : ('warn' as const),
        link: '/my-dtr',
      })),
      empty: 'No DTR yet. HR opens one per cutoff period.',
    },
  ];
}

async function unitAttendance(q: Queryable, departmentId: string, today: string): Promise<MicaFactGroup[]> {
  const today_ = await q.query<{ label: string; scheduled: number; clocked: number; verified: number; absent: number }>(
    `select s.label, count(*)::int as scheduled,
            count(*) filter (where r.status in ('clocked_in', 'present', 'incomplete'))::int as clocked,
            count(*) filter (where r.verified_at is not null)::int as verified,
            count(*) filter (where r.status in ('no_show', 'absent'))::int as absent
       from public.attendance_records r join public.shifts s on s.id = r.shift_id
      where r.department_id = $1 and s.shift_date = $2::date and r.status <> 'excused'
      group by s.label, s.starts_at order by s.starts_at`,
    [departmentId, today],
  );
  const open = await q.query<{ kind: string; n: number }>(
    `select kind, count(*)::int as n from public.attendance_exceptions where department_id = $1 and state = 'open' group by kind order by n desc`,
    [departmentId],
  );
  const [corr] = await q.query<{ n: number }>(`select count(*)::int as n from public.attendance_corrections where department_id = $1 and status = 'pending'`, [departmentId]);
  return [
    {
      title: `Scheduled and verified coverage, ${day(today)}`,
      items: today_.map((r) => ({ label: r.label, value: `${r.scheduled} scheduled · ${r.clocked} clocked in · ${r.verified} verified${r.absent ? ` · ${r.absent} without time-in` : ''}`, tone: r.absent ? ('warn' as const) : undefined, link: '/manager/attendance' })),
      empty: 'No duties today.',
    },
    {
      title: 'Open attendance items in the unit',
      items: [
        ...open.map((x) => ({ label: EXCEPTION_LABEL[x.kind] ?? x.kind, value: String(x.n), tone: 'warn' as const, link: '/manager/attendance' })),
        ...(corr?.n ? [{ label: 'Corrections waiting for you', value: String(corr.n), tone: 'warn' as const, link: '/manager/attendance' }] : []),
      ],
      empty: 'No open attendance items.',
    },
  ];
}

async function hrFacts(q: Queryable): Promise<MicaFactGroup[]> {
  const periods = await q.query<{ pay_group: string; start_date: string; end_date: string; state: string; members: number; certified: number }>(
    `select g.name as pay_group, c.start_date::text as start_date, c.end_date::text as end_date, c.state,
            (select count(*)::int from public.pay_group_members m where m.pay_group_id = c.pay_group_id) as members,
            (select count(*)::int from public.dtr_versions d where d.period_id = c.id and d.state = 'certified') as certified
       from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id order by c.start_date desc limit 4`,
  );
  const open = await q.query<{ department: string; n: number }>(
    `select d.name as department, count(*)::int as n from public.attendance_exceptions x join public.departments d on d.id = x.department_id
      where x.state = 'open' and x.kind in ('missing_in', 'missing_out', 'possible_absence', 'overtime', 'pending_leave')
      group by d.name order by n desc`,
  );
  return [
    {
      title: 'Cutoff periods',
      items: periods.map((p) => ({ label: `${p.pay_group} · ${span(p.start_date, p.end_date)}`, value: p.state === 'locked' ? 'Locked' : `Open · ${p.certified} of ${p.members} DTRs certified`, tone: p.state === 'locked' ? ('ok' as const) : undefined, link: '/hr' })),
      empty: 'No cutoff periods yet.',
    },
    { title: 'Unresolved attendance items blocking DTRs', items: open.map((o) => ({ label: o.department, value: String(o.n), tone: 'warn' as const })), empty: 'None.' },
  ];
}

async function payrollFacts(q: Queryable): Promise<MicaFactGroup[]> {
  const periods = await q.query<{ id: string; pay_group: string; start_date: string; end_date: string; state: string; missing: number }>(
    `select c.id, g.name as pay_group, c.start_date::text as start_date, c.end_date::text as end_date, c.state,
            (select count(*)::int from public.pay_group_members m where m.pay_group_id = c.pay_group_id
              and not exists (select 1 from public.dtr_versions d where d.profile_id = m.profile_id and d.period_id = c.id and d.state = 'certified')) as missing
       from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id order by c.start_date desc limit 4`,
  );
  const runs = await q.query<{ start_date: string; end_date: string; state: string; people: number }>(
    `select c.start_date::text as start_date, c.end_date::text as end_date, r.state, coalesce((r.totals ->> 'people')::int, 0) as people
       from public.payroll_runs r join public.cutoff_periods c on c.id = r.period_id order by r.prepared_at desc limit 4`,
  );
  const RUN: Record<string, string> = { draft: 'Draft (not submitted)', submitted: 'Waiting for Finance', returned: 'Returned to Payroll', approved: 'Approved, not released', released: 'Released' };
  return [
    {
      title: 'Certified DTRs per cutoff',
      items: periods.map((p) => ({
        label: `${p.pay_group} · ${span(p.start_date, p.end_date)}`,
        value: `${p.state === 'locked' ? 'Locked' : 'Open'}${p.missing ? ` · ${plural(p.missing, 'DTR')} not certified` : ' · all certified'}`,
        tone: p.missing ? ('warn' as const) : ('ok' as const),
        link: '/payroll',
      })),
      empty: 'No cutoff periods yet.',
    },
    { title: 'Payroll runs', items: runs.map((r) => ({ label: span(r.start_date, r.end_date), value: `${RUN[r.state] ?? r.state} · ${plural(r.people, 'person', 'people')}`, link: '/payroll' })), empty: 'No payroll runs yet.' },
  ];
}

/** Facts for the attendance, DTR, HR and payroll pages, whatever the base role. */
async function workforceFacts(c: Ctx, page: AssistantPageContext): Promise<MicaFactGroup[] | null> {
  const p = c.get('profile');
  const has = (cap: string) => (p.capabilities ?? []).some((g) => g.capability === cap);
  if (page === 'hr' && (has('timekeeper') || has('hr_admin'))) return asUser(c, hrFacts);
  if (page === 'payroll' && (has('payroll_preparer') || has('finance_approver') || has('hr_admin'))) return asUser(c, payrollFacts);
  if (page === 'team_attendance' && p.role === 'manager' && p.department_id) {
    return asUser(c, async (q) => {
      const d = await departmentToday(q);
      return d ? [todayGroup(d.today), ...(await unitAttendance(q, p.department_id!, d.today))] : [];
    });
  }
  if ((page === 'attendance' || page === 'dtr' || page === 'payslips') && p.role !== 'admin') {
    return asUser(c, async (q) => {
      const d = await departmentToday(q);
      return d ? [todayGroup(d.today), ...(await ownAttendance(q, d.today))] : [];
    });
  }
  return null;
}

export async function micaFacts(c: Ctx, page: AssistantPageContext, entityId?: string): Promise<MicaFactGroup[]> {
  const workforce = await workforceFacts(c, page);
  if (workforce) return workforce;
  const role = c.get('profile').role;
  if (role === 'employee') return employeeFacts(c, page);
  if (role === 'manager') return managerFacts(c, page, entityId);
  return adminFacts(c);
}

/** Whose names may be pseudonymized in this user's question and facts. */
export async function micaRoster(c: Ctx): Promise<RosterEntry[]> {
  return c.get('profile').role === 'admin'
    ? svc(c).db.asService((q) => q.query<RosterEntry>('select full_name, pseudonym from public.profiles'))
    : asUser(c, (q) => q.query<RosterEntry>('select full_name, pseudonym from public.profiles where department_id = app.my_department()'));
}
