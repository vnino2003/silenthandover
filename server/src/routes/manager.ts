import { Hono } from 'hono';
import { z } from 'zod';
import { RECORD_TYPES, REPORT_STATUSES, ReviewDecision } from '@sh/shared';
import { reidentifyDeep } from '../automation/sanitize';
import { ApiError } from '../http/errors';
import { asUser, idParam, one, parseBody, parseQuery, requireRole, svc, type AppEnv } from '../http/context';
import { SHIFT_COLUMNS } from './employee';

export function managerRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    requireRole(c, 'manager');
    await next();
  });

  r.get('/queue', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select r.id, r.reference_code, r.status, r.analysis_state, r.current_revision, r.last_submitted_at, r.is_late,
                s.label, s.shift_date::text as shift_date, s.ends_at, p.full_name as employee_name,
                run.flag_count, run.is_simulated, run.has_safety
           from public.shift_reports r
           join public.shifts s on s.id = r.shift_id
           join public.profiles p on p.id = r.employee_id
           left join lateral (
             select jsonb_array_length(x.flags) as flag_count, x.is_simulated,
                    exists (select 1 from jsonb_array_elements(x.flags) f where f ->> 'type' = 'safety_concern') as has_safety
               from public.ai_analysis_runs x
              where x.report_id = r.id and x.revision_no = r.current_revision and x.status = 'succeeded'
              order by x.created_at desc limit 1) run on true
          where r.department_id = app.my_department()
            and r.status in ('submitted','processing','pending_review','revision_requested')
          order by (r.status = 'pending_review') desc, run.has_safety desc nulls last, r.last_submitted_at`,
      ),
    );
    return c.json(rows);
  });

  r.get('/reports', async (c) => {
    const query = parseQuery(
      c,
      z.object({
        status: z.enum(REPORT_STATUSES).optional(),
        days: z.coerce.number().int().min(1).max(90).default(14),
      }),
    );
    const rows = await asUser(c, (q) =>
      q.query(
        `select r.id, r.reference_code, r.status, r.analysis_state, r.current_revision, r.last_submitted_at, r.is_late,
                s.label, s.shift_date::text as shift_date, p.full_name as employee_name
           from public.shift_reports r
           join public.shifts s on s.id = r.shift_id
           join public.profiles p on p.id = r.employee_id
          where r.department_id = app.my_department() and r.status <> 'draft'
            and ($1::text is null or r.status = $1)
            and s.starts_at > now() - make_interval(days => $2)
          order by s.starts_at desc`,
        [query.status ?? null, query.days],
      ),
    );
    return c.json(rows);
  });

  // Review workspace: original submission next to the draft, flags, source records, open issues.
  r.get('/reports/:id', async (c) => {
    const id = idParam(c);
    const data = await asUser(c, async (q) => {
      const report = await one<{ id: string; shift_id: string; current_revision: number; department_id: string }>(
        q,
        `select r.id, r.reference_code, r.status, r.analysis_state, r.current_revision, r.first_submitted_at, r.last_submitted_at,
                r.is_late, r.shift_id, r.department_id, r.employee_id, p.full_name as employee_name, p.pseudonym as employee_pseudonym
           from public.shift_reports r join public.profiles p on p.id = r.employee_id
          where r.id = $1 and app.is_manager_of(r.department_id)`,
        [id],
      );
      const [shift] = await q.query(
        `select ${SHIFT_COLUMNS} from public.shifts s
           join public.departments d on d.id = s.department_id
           left join public.teams t on t.id = s.team_id
           left join public.profiles sup on sup.id = s.supervisor_id
          where s.id = $1`,
        [report.shift_id],
      );
      const revisions = await q.query(
        'select revision_no, content, submitted_at, is_late from public.report_revisions where report_id = $1 order by revision_no desc',
        [id],
      );
      const runs = await q.query<{ id: string; revision_no: number; status: string; draft: unknown; flags: unknown }>(
        `select id, revision_no, attempt, status, prompt_version, engine, model, is_simulated, draft, flags, validation_errors,
                latency_ms, created_at
           from public.ai_analysis_runs where report_id = $1 order by created_at desc limit 20`,
        [id],
      );
      const decisions = await q.query(
        `select a.id, a.decision, a.note, a.decided_at, a.revision_no, a.approved_content, a.flag_resolutions, p.full_name as reviewer_name
           from public.handover_approvals a join public.profiles p on p.id = a.reviewer_id
          where a.report_id = $1 order by a.decided_at desc`,
        [id],
      );
      const records = await q.query(
        `select id, record_type, reference_code, title, details, recorded_at from public.operational_records
          where department_id = $1
            and (record_type = 'policy' or recorded_at between $2::timestamptz - interval '72 hours' and $2::timestamptz + interval '6 hours')
          order by recorded_at desc limit 40`,
        [report.department_id, (shift as { ends_at: Date }).ends_at],
      );
      const openIssues = await q.query(
        `select id, code, title, status, severity, is_safety from public.operational_issues
          where department_id = $1 and status in ('reported','pending_verification','open','in_progress','resolution_submitted')
          order by created_at desc limit 100`,
        [report.department_id],
      );
      const [next] = await q.query<{ id: string }>(
        `select n.id, n.label, n.starts_at,
                coalesce((select jsonb_agg(p.full_name order by p.full_name) from public.shift_assignments a
                           join public.profiles p on p.id = a.employee_id
                          where a.shift_id = n.id and a.removed_at is null), '[]'::jsonb) as assignees
           from public.shifts n where n.id = app.next_shift($1)`,
        [report.shift_id],
      );
      const deliveries = await q.query(
        `select d.id, p.full_name as recipient_name, d.delivered_at, k.acknowledged_at, k.note as acknowledgment_note
           from public.handover_deliveries d join public.profiles p on p.id = d.recipient_id
           left join public.handover_acknowledgments k on k.delivery_id = d.id
          where d.report_id = $1 order by p.full_name`,
        [id],
      );
      return { report, shift, revisions, runs, decisions, records, open_issues: openIssues, next_shift: next ?? null, deliveries };
    });

    // Access to the report is proven above (RLS + is_manager_of). Only then read the restricted
    // record of what was sent to the AI and re-identify pseudonyms for this reviewer.
    const input = await svc(c).db.asService(async (q) => {
      const [row] = await q.query<{ sanitized_text: string; name_mapping: Record<string, string>; redaction_counts: unknown; injection_findings: unknown; expires_at: Date }>(
        `select sanitized_text, name_mapping, redaction_counts, injection_findings, expires_at
           from internal.analysis_inputs where report_id = $1 and revision_no = $2`,
        [id, data.report.current_revision],
      );
      return row ?? null;
    });
    const mapping = input?.name_mapping ?? {};
    const runs = data.runs.map((run) => ({ ...run, draft: reidentifyDeep(run.draft, mapping), flags: reidentifyDeep(run.flags, mapping) }));
    return c.json({
      ...data,
      runs,
      analysis_input: input
        ? { sanitized_text: input.sanitized_text, redaction_counts: input.redaction_counts, injection_findings: input.injection_findings, expires_at: input.expires_at }
        : null,
    });
  });

  r.post('/reports/:id/decision', async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, ReviewDecision);
    const content = body.decision === 'approved' ? JSON.stringify(body.content) : null;
    const resolutions = body.decision === 'approved' ? JSON.stringify(body.flag_resolutions) : '[]';
    const result = await asUser(c, async (q) =>
      (await q.query<{ r: unknown }>('select app.decide_report($1, $2, $3::jsonb, $4::jsonb, $5) as r', [id, body.decision, content, resolutions, body.note]))[0]!.r,
    );
    svc(c).kick();
    return c.json(result);
  });

  r.post('/reports/:id/reanalyze', async (c) => {
    const id = idParam(c);
    const event = await asUser(c, async (q) => (await q.query<{ e: string }>('select app.request_reanalysis($1) as e', [id]))[0]!.e);
    svc(c).kick();
    return c.json({ event_id: event }, 202);
  });

  // Shift board: who is on each shift, report status, missing reports, acknowledgments.
  r.get('/shift-board', async (c) => {
    const { date } = parseQuery(c, z.object({ date: z.iso.date().optional() }));
    const rows = await asUser(c, async (q) => {
      const tz = (await q.query<{ tz: string }>('select timezone as tz from public.departments where id = app.my_department()'))[0]?.tz ?? 'UTC';
      const day = date ?? (await q.query<{ d: string }>('select (now() at time zone $1)::date::text as d', [tz]))[0]!.d;
      const shifts = await q.query(
        `select ${SHIFT_COLUMNS},
                case when now() < s.starts_at then 'upcoming' when now() < s.ends_at then 'active'
                     when now() < s.window_closes_at then 'reporting' else 'ended' end as phase,
                coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'employee_id', a.employee_id, 'employee_name', p.full_name,
                    'report_id', r.id, 'report_status', r.status, 'reference_code', r.reference_code, 'is_late', r.is_late,
                    'override_expires_at', (select max(o.expires_at) from public.report_window_overrides o
                                             where o.shift_id = s.id and o.employee_id = a.employee_id and o.expires_at > now()),
                    'missing', now() >= s.window_closes_at and (r.id is null or r.status = 'draft'),
                    'incoming_delivery', (select jsonb_agg(jsonb_build_object('reference', ap.report_reference, 'acknowledged_at', k.acknowledged_at))
                                            from public.handover_deliveries hd
                                            join public.handover_approvals ap on ap.id = hd.approval_id
                                            left join public.handover_acknowledgments k on k.delivery_id = hd.id
                                           where hd.shift_id = s.id and hd.recipient_id = a.employee_id))
                    order by p.full_name)
                   from public.shift_assignments a
                   join public.profiles p on p.id = a.employee_id
                   left join public.shift_reports r on r.shift_id = s.id and r.employee_id = a.employee_id
                  where a.shift_id = s.id and a.removed_at is null), '[]'::jsonb) as assignees
           from public.shifts s
           join public.departments d on d.id = s.department_id
           left join public.teams t on t.id = s.team_id
           left join public.profiles sup on sup.id = s.supervisor_id
          where s.department_id = app.my_department() and s.shift_date between $1::date - 1 and $1::date
          order by s.starts_at`,
        [day],
      );
      return { date: day, timezone: tz, shifts };
    });
    return c.json(rows);
  });

  r.post('/shifts/:id/override', async (c) => {
    const id = idParam(c);
    const body = await parseBody(
      c,
      z.strictObject({ employee_id: z.uuid(), minutes: z.number().int().min(5).max(1440), reason: z.string().trim().min(3).max(500) }),
    );
    const overrideId = await asUser(c, async (q) =>
      (await q.query<{ id: string }>('select app.grant_window_override($1, $2, $3, $4) as id', [id, body.employee_id, body.minutes, body.reason]))[0]!.id,
    );
    return c.json({ id: overrideId }, 201);
  });

  r.get('/records', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select o.id, o.record_type, o.reference_code, o.title, o.details, o.recorded_at, p.full_name as recorded_by_name
           from public.operational_records o left join public.profiles p on p.id = o.recorded_by
          where o.department_id = app.my_department() order by o.recorded_at desc limit 200`,
      ),
    );
    return c.json(rows);
  });

  r.post('/records', async (c) => {
    const body = await parseBody(
      c,
      z.strictObject({
        record_type: z.enum(RECORD_TYPES),
        reference_code: z.string().trim().min(2).max(60),
        title: z.string().trim().min(3).max(160),
        details: z.string().trim().max(2000).default(''),
        recorded_at: z.iso.datetime({ offset: true }).nullable().default(null),
      }),
    );
    const id = await asUser(c, async (q) =>
      (await q.query<{ id: string }>('select app.add_operational_record($1, $2, $3, $4, $5::timestamptz) as id', [
        body.record_type,
        body.reference_code,
        body.title,
        body.details,
        body.recorded_at,
      ]))[0]!.id,
    );
    return c.json({ id }, 201);
  });

  r.get('/summary', async (c) => {
    const data = await asUser(c, async (q) => {
      const [counts] = await q.query(
        `select
           (select count(*)::int from public.shift_reports where department_id = app.my_department() and status = 'pending_review') as pending_review,
           (select count(*)::int from public.shift_reports where department_id = app.my_department() and status in ('submitted','processing')) as processing,
           (select count(*)::int from public.operational_issues where department_id = app.my_department() and status = 'resolution_submitted') as awaiting_verification,
           (select count(*)::int from public.operational_issues where department_id = app.my_department()
              and status in ('reported','pending_verification','open','in_progress','resolution_submitted') and is_safety) as open_safety,
           (select count(*)::int from public.operational_issues where department_id = app.my_department()
              and status in ('reported','pending_verification','open','in_progress','resolution_submitted')) as open_issues`,
      );
      return counts;
    });
    if (!data) throw new ApiError(404, 'not_found', 'Not found');
    return c.json(data);
  });

  return r;
}
