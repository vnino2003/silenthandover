import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireCapability, requireRole, svc, type AppEnv, type Ctx } from '../http/context';
import type { Queryable } from '../db/types';
import { codeIsValid, newStationSecret } from '../services/attendance-codes';

/**
 * Attendance, DTR, HR timekeeping, payroll and finance. Every rule (who may verify, approve,
 * certify, lock, prepare or approve pay, never one's own) is enforced by the database functions;
 * these routes validate input and shape the data. Payroll and Finance views carry certified totals
 * only: no punches, device evidence or leave reasons.
 */
const date = z.iso.date();
const Range = z.object({ from: date.optional(), to: date.optional(), department_id: z.uuid().optional() });

const todayIn = (tz: string | null) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz ?? 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Recomputes a department's attendance (service role; idempotent). */
const reconcile = (c: Ctx, department: string, from: string, to: string) =>
  svc(c).db.asService((q) => q.query('select internal.reconcile_department($1, $2::date, $3::date)', [department, from, to]));

/** The department a Head Nurse (own) or Nursing Service (chosen) is looking at. */
async function supervisedDepartment(c: Ctx, requested?: string): Promise<string> {
  const p = c.get('profile');
  const dept = requested ?? p.department_id;
  if (!dept) throw new ApiError(403, 'forbidden', 'You do not have access to this area');
  const [ok] = await asUser(c, (q) => q.query<{ ok: boolean }>('select app.can_supervise_attendance($1) as ok', [dept]));
  if (!ok?.ok) throw new ApiError(403, 'forbidden', 'You do not have access to this area');
  return dept;
}

const RECORD_COLUMNS = `r.id, r.shift_id, r.profile_id, p.full_name, p.job_title, s.label as shift_label, s.shift_date::text as shift_date,
  r.status, r.scheduled_start, r.scheduled_end, r.time_in, r.time_out, r.worked_minutes, r.late_minutes, r.undertime_minutes,
  r.overtime_candidate_minutes, r.overtime_approved_minutes, r.overtime_treatment, r.paid_leave_minutes, r.unpaid_leave_minutes,
  r.verified_at, r.locked_at,
  (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'source', e.source, 'at', e.captured_at) order by e.captured_at), '[]'::jsonb)
     from public.attendance_events e
    where e.profile_id = r.profile_id and e.captured_at between r.scheduled_start - interval '2 hours' and r.scheduled_end + interval '4 hours'
      and not exists (select 1 from public.attendance_event_voids v where v.event_id = e.id)) as punches`;

async function periodsFor(q: Queryable, profileId: string) {
  return q.query(
    `select c.id, c.start_date::text as start_date, c.end_date::text as end_date, c.pay_date::text as pay_date, c.state, g.name as pay_group
       from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id
      where c.pay_group_id = (select pay_group_id from public.pay_group_members where profile_id = $1)
      order by c.start_date desc limit 24`,
    [profileId],
  );
}

export function workforceRoutes() {
  const r = new Hono<AppEnv>();

  // ---- Staff: time-in/out, own records, corrections, DTR, payslips --------------------------
  r.post('/attendance/scan', async (c) => {
    requireRole(c, 'employee', 'manager');
    const b = await parseBody(c, z.strictObject({ station_id: z.uuid(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), event_key: z.string().min(8).max(120).optional() }));
    const s = svc(c);
    const [station] = await s.db.asService((q) =>
      q.query<{ secret: string; department_id: string; is_active: boolean }>(
        `select x.secret, st.department_id, st.is_active from internal.attendance_station_secrets x
           join public.attendance_stations st on st.id = x.station_id where x.station_id = $1`,
        [b.station_id],
      ),
    );
    if (!station || !station.is_active) throw new ApiError(404, 'not_found', 'This attendance station is not active');
    if (station.department_id !== c.get('profile').department_id) throw new ApiError(403, 'forbidden', 'This station belongs to another unit');
    if (!codeIsValid(station.secret, b.station_id, b.code)) {
      throw new ApiError(422, 'expired_code', 'That code has changed. Scan the station again or type the code now shown.');
    }
    const eventKey = b.event_key ?? `qr:${c.get('userId')}:${randomUUID()}`;
    const [row] = await s.db.asService((q) =>
      q.query<{ r: Record<string, unknown> }>('select internal.record_station_punch($1, $2, $3) as r', [c.get('userId'), b.station_id, eventKey]),
    );
    return c.json(row!.r);
  });

  r.get('/attendance/me', async (c) => {
    requireRole(c, 'employee', 'manager');
    const p = c.get('profile');
    const today = todayIn(p.department_timezone);
    const q0 = parseQuery(c, Range);
    const from = q0.from ?? addDays(today, -14);
    const to = q0.to ?? addDays(today, 1);
    if (p.department_id) await reconcile(c, p.department_id, addDays(from, -1), to);
    return c.json(
      await asUser(c, async (q) => ({
        today,
        records: await q.query(
          `select ${RECORD_COLUMNS} from public.attendance_records r join public.shifts s on s.id = r.shift_id join public.profiles p on p.id = r.profile_id
            where r.profile_id = $1 and s.shift_date between $2::date and $3::date order by r.scheduled_start desc`,
          [p.id, from, to],
        ),
        exceptions: await q.query(
          `select x.id, x.kind, x.detail, x.shift_id, x.event_id, x.created_at, s.label as shift_label, s.shift_date::text as shift_date
             from public.attendance_exceptions x left join public.shifts s on s.id = x.shift_id
            where x.profile_id = $1 and x.state = 'open' order by x.created_at desc`,
          [p.id],
        ),
        corrections: await q.query(
          `select id, kind, shift_id, proposed_at, reason, status, decision_note, requested_at, decided_at
             from public.attendance_corrections where profile_id = $1 order by requested_at desc limit 30`,
          [p.id],
        ),
        stations: await q.query(`select id, name from public.attendance_stations where department_id = $1 and is_active order by name`, [p.department_id]),
      })),
    );
  });

  r.post('/attendance/corrections', async (c) => {
    requireRole(c, 'employee', 'manager');
    const b = await parseBody(
      c,
      z.strictObject({ shift_id: z.uuid().nullable().optional(), kind: z.enum(['add_in', 'add_out', 'void_punch']), at: z.iso.datetime({ offset: true }).nullable().optional(), event_id: z.uuid().nullable().optional(), reason: z.string().trim().min(3).max(500) }),
    );
    const [row] = await asUser(c, (q) =>
      q.query<{ id: string }>('select app.request_attendance_correction($1, $2, $3, $4, $5) as id', [b.shift_id ?? null, b.kind, b.at ?? null, b.event_id ?? null, b.reason]),
    );
    return c.json({ id: row!.id }, 201);
  });

  r.get('/dtr/periods', async (c) => c.json(await asUser(c, (q) => periodsFor(q, c.get('userId')))));

  r.get('/dtr/mine/:id', async (c) => {
    const period = idParam(c);
    return c.json(
      await asUser(c, async (q) => {
        const [{ id }] = (await q.query<{ id: string }>('select app.open_dtr($1, $2) as id', [c.get('userId'), period])) as [{ id: string }];
        return dtrView(q, id);
      }),
    );
  });

  r.get('/dtr/:id', async (c) => {
    const id = idParam(c);
    return c.json(await asUser(c, (q) => dtrView(q, id)));
  });

  r.post('/dtr/:id/confirm', async (c) => {
    const id = idParam(c);
    await asUser(c, (q) => q.query('select app.confirm_my_dtr($1)', [id]));
    return c.json({ ok: true });
  });

  r.get('/payslips', async (c) =>
    c.json(
      await asUser(c, (q) =>
        q.query(
          `select pr.id as run_id, cp.start_date::text as start_date, cp.end_date::text as end_date, cp.pay_date::text as pay_date, pr.released_at,
                  jsonb_agg(jsonb_build_object('kind', l.kind, 'label', l.label, 'quantity', l.quantity, 'rate', l.rate, 'amount', l.amount) order by l.sort) as lines,
                  sum(case when l.kind = 'earning' then l.amount else -l.amount end) as net
             from public.payroll_lines l join public.payroll_runs pr on pr.id = l.run_id join public.cutoff_periods cp on cp.id = pr.period_id
            where l.profile_id = $1 and pr.state = 'released'
            group by pr.id, cp.start_date, cp.end_date, cp.pay_date, pr.released_at order by cp.start_date desc`,
          [c.get('userId')],
        ),
      ),
    ),
  );

  // ---- Head Nurse / Nursing Service ------------------------------------------------------
  r.get('/manager/attendance', async (c) => {
    const q0 = parseQuery(c, Range);
    const dept = await supervisedDepartment(c, q0.department_id);
    const [{ tz }] = (await asUser(c, (q) => q.query<{ tz: string }>('select timezone as tz from public.departments where id = $1', [dept]))) as [{ tz: string }];
    const today = todayIn(tz);
    const from = q0.from ?? today;
    const to = q0.to ?? from;
    await reconcile(c, dept, addDays(from, -1), to);
    return c.json(
      await asUser(c, async (q) => ({
        department_id: dept,
        today,
        from,
        to,
        records: await q.query(
          `select ${RECORD_COLUMNS} from public.attendance_records r join public.shifts s on s.id = r.shift_id join public.profiles p on p.id = r.profile_id
            where r.department_id = $1 and s.shift_date between $2::date and $3::date order by r.scheduled_start, p.full_name`,
          [dept, from, to],
        ),
        exceptions: await q.query(
          `select x.id, x.kind, x.detail, x.shift_id, x.event_id, x.profile_id, p.full_name, x.created_at, s.label as shift_label, s.shift_date::text as shift_date,
                  (select r.id from public.attendance_records r where r.shift_id = x.shift_id and r.profile_id = x.profile_id) as record_id
             from public.attendance_exceptions x join public.profiles p on p.id = x.profile_id left join public.shifts s on s.id = x.shift_id
            where x.department_id = $1 and x.state = 'open' order by x.created_at desc limit 200`,
          [dept],
        ),
        corrections: await q.query(
          `select k.id, k.kind, k.shift_id, k.proposed_at, k.reason, k.requested_at, p.full_name, k.profile_id, s.label as shift_label, s.shift_date::text as shift_date
             from public.attendance_corrections k join public.profiles p on p.id = k.profile_id left join public.shifts s on s.id = k.shift_id
            where k.department_id = $1 and k.status = 'pending' order by k.requested_at`,
          [dept],
        ),
        stations: await q.query(
          `select id, name, kind, is_active, last_seen_at from public.attendance_stations where department_id = $1 order by created_at`,
          [dept],
        ),
        staff: await q.query(
          `select id, full_name, job_title from public.profiles where department_id = $1 and role = 'employee' and is_active order by full_name`,
          [dept],
        ),
        coverage: await q.query(
          `select v.id, v.reason, v.emergency, v.retrospective, v.authorized_at, s.label as shift_label, s.shift_date::text as shift_date,
                  o.full_name as original_name, n.full_name as replacement_name
             from public.coverage_changes v join public.shifts s on s.id = v.shift_id
             join public.profiles o on o.id = v.original_profile_id join public.profiles n on n.id = v.replacement_profile_id
            where v.department_id = $1 order by v.authorized_at desc limit 20`,
          [dept],
        ),
      })),
    );
  });

  const call = (sql: string, params: unknown[]) => async (c: Ctx) => {
    const [row] = await asUser(c, (q) => q.query<{ v: unknown }>(sql, params));
    return row?.v;
  };

  r.post('/manager/attendance/attest', async (c) => {
    const b = await parseBody(c, z.strictObject({ shift_id: z.uuid(), profile_id: z.uuid(), kind: z.enum(['in', 'out']), at: z.iso.datetime({ offset: true }), reason: z.string().trim().min(3).max(500) }));
    return c.json({ id: await call('select app.attest_attendance($1, $2, $3, $4, $5) as v', [b.shift_id, b.profile_id, b.kind, b.at, b.reason])(c) }, 201);
  });
  r.post('/manager/attendance/verify', async (c) => {
    const b = await parseBody(c, z.strictObject({ record_ids: z.array(z.uuid()).min(1).max(200) }));
    return c.json({ verified: await call('select app.verify_attendance($1::uuid[]) as v', [b.record_ids])(c) });
  });
  r.post('/manager/attendance/records/:id/absent', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ note: z.string().trim().max(300).default('') }));
    await call('select app.confirm_absence($1, $2) as v', [id, b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/manager/attendance/records/:id/overtime', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ minutes: z.number().int().min(0).max(24 * 60), treatment: z.enum(['pay', 'compensatory_time']).nullable(), note: z.string().trim().max(300).default('') }));
    await call('select app.decide_overtime($1, $2, $3, $4) as v', [id, b.minutes, b.treatment ?? '', b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/manager/attendance/exceptions/:id/resolve', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ note: z.string().trim().min(3).max(300) }));
    await call('select app.resolve_attendance_exception($1, $2) as v', [id, b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/manager/attendance/corrections/:id/decision', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).default('') }));
    await call('select app.decide_attendance_correction($1, $2, $3) as v', [id, b.decision, b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/manager/attendance/replace', async (c) => {
    const b = await parseBody(c, z.strictObject({ shift_id: z.uuid(), original_id: z.uuid(), replacement_id: z.uuid(), reason: z.string().trim().min(3).max(500), emergency: z.boolean().default(false) }));
    return c.json({ id: await call('select app.replace_on_shift($1, $2, $3, $4, $5) as v', [b.shift_id, b.original_id, b.replacement_id, b.reason, b.emergency])(c) }, 201);
  });
  // Stations: the key is shown once, to open the station display on the unit's tablet.
  r.post('/manager/attendance/stations', async (c) => {
    const b = await parseBody(c, z.strictObject({ name: z.string().trim().min(2).max(80), kind: z.enum(['qr_station', 'device']).default('qr_station') }));
    const key = newStationSecret();
    const id = (await call('select app.create_attendance_station($1, $2, $3) as v', [b.name, key, b.kind])(c)) as string;
    return c.json({ id, key }, 201);
  });
  r.post('/manager/attendance/stations/:id/reset', async (c) => {
    const id = idParam(c);
    const key = newStationSecret();
    await call('select app.rotate_attendance_station($1, $2, true) as v', [id, key])(c);
    return c.json({ id, key });
  });
  r.post('/manager/attendance/stations/:id/disable', async (c) => {
    const id = idParam(c);
    await call('select app.rotate_attendance_station($1, null, false) as v', [id])(c);
    return c.json({ ok: true });
  });
  r.post('/manager/attendance/stations/:id/staff', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ external_ref: z.string().trim().min(1).max(64), profile_id: z.uuid() }));
    const dept = await supervisedDepartment(c);
    await svc(c).db.asService((q) =>
      q.query(
        `insert into public.attendance_device_staff (station_id, external_ref, profile_id)
         select $1, $2, $3 where exists (select 1 from public.attendance_stations where id = $1 and department_id = $4 and kind = 'device')
           and exists (select 1 from public.profiles where id = $3 and department_id = $4)
         on conflict (station_id, external_ref) do update set profile_id = excluded.profile_id`,
        [id, b.external_ref, b.profile_id, dept],
      ),
    );
    return c.json({ ok: true });
  });

  // DTRs of the unit for a period, and certification.
  r.get('/manager/dtr', async (c) => {
    const q0 = parseQuery(c, z.object({ period_id: z.uuid().optional(), department_id: z.uuid().optional() }));
    const dept = await supervisedDepartment(c, q0.department_id);
    return c.json(
      await asUser(c, async (q) => {
        const periods = await q.query(
          `select c.id, c.start_date::text as start_date, c.end_date::text as end_date, c.state, g.name as pay_group
             from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id order by c.start_date desc limit 12`,
        );
        const period = q0.period_id ?? (periods[0] as { id?: string } | undefined)?.id;
        if (!period) return { periods, period_id: null, people: [] };
        const members = await q.query<{ id: string; full_name: string }>(
          `select p.id, p.full_name from public.profiles p join public.pay_group_members m on m.profile_id = p.id
            join public.cutoff_periods c on c.pay_group_id = m.pay_group_id and c.id = $2
            where p.department_id = $1 and p.is_active order by p.full_name`,
          [dept, period],
        );
        const people = [];
        for (const m of members) {
          const [{ id }] = (await q.query<{ id: string }>('select app.open_dtr($1, $2) as id', [m.id, period])) as [{ id: string }];
          const [d] = await q.query(`select id, version, state, totals, blocking_items, staff_confirmed_at, certified_at from public.dtr_versions where id = $1`, [id]);
          people.push({ profile_id: m.id, full_name: m.full_name, ...(d as object) });
        }
        return { periods, period_id: period, people };
      }),
    );
  });
  r.post('/manager/dtr/:id/certify', async (c) => {
    const id = idParam(c);
    await call('select app.certify_dtr($1) as v', [id])(c);
    return c.json({ ok: true });
  });

  // ---- HR timekeeping ------------------------------------------------------------------------
  r.get('/hr/overview', async (c) => {
    requireCapability(c, 'timekeeper', 'hr_admin');
    return c.json(
      await asUser(c, async (q) => ({
        pay_groups: await q.query(`select id, name, employment_category, cutoff from public.pay_groups where is_active order by name`),
        periods: await q.query(
          `select c.id, c.pay_group_id, g.name as pay_group, c.start_date::text as start_date, c.end_date::text as end_date, c.pay_date::text as pay_date, c.state, c.locked_at,
                  (select count(*)::int from public.pay_group_members m where m.pay_group_id = c.pay_group_id) as members,
                  (select count(*)::int from public.dtr_versions d where d.period_id = c.id and d.state = 'certified') as certified
             from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id order by c.start_date desc limit 24`,
        ),
        exceptions: await q.query(
          `select x.kind, d.name as department, count(*)::int as open
             from public.attendance_exceptions x join public.departments d on d.id = x.department_id
            where x.state = 'open' group by x.kind, d.name order by d.name, x.kind`,
        ),
        staff: await q.query(
          `select p.id, p.full_name, p.job_title, d.name as department, m.pay_group_id
             from public.profiles p left join public.departments d on d.id = p.department_id
             left join public.pay_group_members m on m.profile_id = p.id
            where p.is_active and p.role in ('employee', 'manager') order by d.name nulls last, p.full_name`,
        ),
        policy: (await q.query(`select version, effective_from::text as effective_from, rules, note from public.workforce_policies order by version desc limit 1`))[0] ?? null,
      })),
    );
  });
  r.post('/hr/periods', async (c) => {
    requireCapability(c, 'timekeeper', 'hr_admin');
    const b = await parseBody(c, z.strictObject({ pay_group_id: z.uuid(), start_date: date, end_date: date, pay_date: date }));
    return c.json({ id: await call('select app.create_cutoff_period($1, $2, $3, $4) as v', [b.pay_group_id, b.start_date, b.end_date, b.pay_date])(c) }, 201);
  });
  r.post('/hr/periods/:id/lock', async (c) => {
    requireCapability(c, 'timekeeper');
    const id = idParam(c);
    await call('select app.lock_period($1) as v', [id])(c);
    return c.json({ ok: true });
  });
  r.get('/hr/periods/:id/dtrs', async (c) => {
    requireCapability(c, 'timekeeper', 'hr_admin');
    const id = idParam(c);
    return c.json(await asUser(c, (q) => periodDtrs(q, id)));
  });
  // Totals per person for the period, CSV (certified versions only).
  r.get('/hr/periods/:id/export.csv', async (c) => {
    requireCapability(c, 'timekeeper', 'hr_admin', 'payroll_preparer');
    const id = idParam(c);
    const rows = (await asUser(c, (q) => periodDtrs(q, id))).filter((r) => r.state === 'certified');
    const cols = ['scheduled_minutes', 'worked_minutes', 'regular_payable_minutes', 'late_minutes', 'undertime_minutes', 'absences', 'paid_leave_minutes', 'unpaid_leave_minutes', 'overtime_pay_minutes', 'compensatory_minutes', 'night_minutes'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [['name', 'department', 'dtr_version', ...cols].join(','), ...rows.map((r) => [esc(r.full_name), esc(r.department), r.version, ...cols.map((k) => (r.totals as Record<string, unknown>)[k] ?? 0)].join(','))].join('\n');
    await asUser(c, (q) => q.query('select app.record_dtr_export($1, $2)', [id, rows.length]));
    return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="dtr-${id}.csv"` });
  });
  r.post('/hr/pay-group-members', async (c) => {
    requireCapability(c, 'timekeeper', 'hr_admin');
    const b = await parseBody(c, z.strictObject({ profile_id: z.uuid(), pay_group_id: z.uuid().nullable() }));
    await call('select app.set_pay_group_member($1, $2) as v', [b.profile_id, b.pay_group_id])(c);
    return c.json({ ok: true });
  });

  // ---- Payroll and Finance -------------------------------------------------------------------
  r.get('/payroll/overview', async (c) => {
    requireCapability(c, 'payroll_preparer', 'finance_approver', 'hr_admin');
    return c.json(
      await asUser(c, async (q) => ({
        periods: await q.query(
          `select c.id, g.name as pay_group, c.start_date::text as start_date, c.end_date::text as end_date, c.pay_date::text as pay_date, c.state
             from public.cutoff_periods c join public.pay_groups g on g.id = c.pay_group_id where c.state = 'locked' order by c.start_date desc limit 12`,
        ),
        runs: await q.query(
          `select r.id, r.period_id, r.state, r.totals, r.prepared_at, r.submitted_at, r.approved_at, r.released_at, r.decision_note,
                  pp.full_name as prepared_by_name, ap.full_name as approved_by_name, r.prepared_by, c.start_date::text as start_date, c.end_date::text as end_date
             from public.payroll_runs r join public.cutoff_periods c on c.id = r.period_id
             join public.profiles pp on pp.id = r.prepared_by left join public.profiles ap on ap.id = r.approved_by
            order by r.prepared_at desc limit 24`,
        ),
        compensation: await q.query(
          `select p.id as profile_id, p.full_name, d.name as department,
                  (select jsonb_build_object('monthly_basic', s.monthly_basic, 'effective_from', s.effective_from) from public.compensation_settings s
                    where s.profile_id = p.id order by s.effective_from desc limit 1) as current
             from public.profiles p join public.pay_group_members m on m.profile_id = p.id left join public.departments d on d.id = p.department_id
            where p.is_active order by p.full_name`,
        ),
        policy: (await q.query(`select version, rules, note from public.workforce_policies order by version desc limit 1`))[0] ?? null,
      })),
    );
  });
  r.get('/payroll/runs/:id', async (c) => {
    requireCapability(c, 'payroll_preparer', 'finance_approver', 'hr_admin');
    const id = idParam(c);
    return c.json(
      await asUser(c, async (q) => ({
        run: (await q.query(`select r.*, c.start_date::text as start_date, c.end_date::text as end_date from public.payroll_runs r join public.cutoff_periods c on c.id = r.period_id where r.id = $1`, [id]))[0] ?? null,
        people: await q.query(
          `select l.profile_id, p.full_name, d.version as dtr_version, d.totals as dtr_totals,
                  jsonb_agg(jsonb_build_object('kind', l.kind, 'code', l.code, 'label', l.label, 'quantity', l.quantity, 'rate', l.rate, 'amount', l.amount) order by l.sort) as lines,
                  sum(case when l.kind = 'earning' then l.amount else -l.amount end) as net
             from public.payroll_lines l join public.profiles p on p.id = l.profile_id left join public.dtr_versions d on d.id = l.dtr_version_id
            where l.run_id = $1 group by l.profile_id, p.full_name, d.version, d.totals order by p.full_name`,
          [id],
        ),
      })),
    );
  });
  r.post('/payroll/runs', async (c) => {
    requireCapability(c, 'payroll_preparer');
    const b = await parseBody(c, z.strictObject({ period_id: z.uuid() }));
    return c.json({ id: await call('select app.prepare_payroll($1) as v', [b.period_id])(c) }, 201);
  });
  r.post('/payroll/runs/:id/submit', async (c) => {
    requireCapability(c, 'payroll_preparer');
    await call('select app.submit_payroll($1) as v', [idParam(c)])(c);
    return c.json({ ok: true });
  });
  r.put('/payroll/compensation/:id', async (c) => {
    requireCapability(c, 'hr_admin');
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ monthly_basic: z.number().min(0).max(10_000_000), effective_from: date, note: z.string().trim().max(200).default('') }));
    await call('select app.set_compensation($1, $2, $3, $4) as v', [id, b.monthly_basic, b.effective_from, b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/payroll/adjustments', async (c) => {
    requireCapability(c, 'payroll_preparer', 'hr_admin');
    const b = await parseBody(c, z.strictObject({ profile_id: z.uuid(), kind: z.enum(['earning', 'deduction']), amount: z.number().positive().max(1_000_000), label: z.string().trim().min(3).max(120), reason: z.string().trim().min(3).max(500), for_period_id: z.uuid().nullable().default(null) }));
    return c.json({ id: await call('select app.add_payroll_adjustment($1, $2, $3, $4, $5, $6) as v', [b.profile_id, b.kind, b.amount, b.label, b.reason, b.for_period_id])(c) }, 201);
  });
  r.post('/finance/runs/:id/decision', async (c) => {
    requireCapability(c, 'finance_approver');
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ decision: z.enum(['approved', 'returned']), note: z.string().trim().max(500).default('') }));
    await call('select app.decide_payroll($1, $2, $3) as v', [id, b.decision, b.note])(c);
    return c.json({ ok: true });
  });
  r.post('/finance/runs/:id/release', async (c) => {
    requireCapability(c, 'finance_approver');
    await call('select app.release_payroll($1) as v', [idParam(c)])(c);
    return c.json({ ok: true });
  });

  return r;
}

async function dtrView(q: Queryable, id: string) {
  const [d] = await q.query(
    `select d.id, d.profile_id, p.full_name, p.job_title, dep.name as department, d.version, d.state, d.totals, d.days, d.blocking_items,
            d.staff_confirmed_at, d.certified_at, cp.full_name as certified_by_name, c.id as period_id, c.start_date::text as start_date,
            c.end_date::text as end_date, c.state as period_state, d.policy_version
       from public.dtr_versions d join public.profiles p on p.id = d.profile_id join public.cutoff_periods c on c.id = d.period_id
       left join public.departments dep on dep.id = d.department_id left join public.profiles cp on cp.id = d.certified_by
      where d.id = $1`,
    [id],
  );
  if (!d) throw new ApiError(404, 'not_found', 'DTR not found');
  return d;
}

async function periodDtrs(q: Queryable, period: string) {
  return q.query<{ full_name: string; department: string | null; version: number; state: string; totals: unknown; profile_id: string }>(
    `select p.id as profile_id, p.full_name, dep.name as department, d.version, coalesce(d.state, 'missing') as state, d.totals, d.blocking_items, d.certified_at
       from public.pay_group_members m join public.cutoff_periods c on c.pay_group_id = m.pay_group_id and c.id = $1
       join public.profiles p on p.id = m.profile_id left join public.departments dep on dep.id = p.department_id
       left join lateral (select * from public.dtr_versions x where x.profile_id = p.id and x.period_id = $1 order by x.version desc limit 1) d on true
      order by dep.name nulls last, p.full_name`,
    [period],
  );
}
