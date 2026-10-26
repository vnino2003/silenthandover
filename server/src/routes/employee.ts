import { Hono } from 'hono';
import { z } from 'zod';
import { ReportDraftContent, ReportSubmission } from '@sh/shared';
import { ApiError, fromZodError } from '../http/errors';
import { asUser, idParam, one, parseBody, requireRole, svc, type AppEnv } from '../http/context';
import type { Queryable } from '../db/types';

export const SHIFT_COLUMNS = `
  s.id, s.label, s.shift_date::text as shift_date, s.timezone, s.status, s.starts_at, s.ends_at,
  s.window_opens_at, s.window_closes_at, s.allow_early_draft,
  d.name as department_name, t.name as team_name, sup.full_name as supervisor_name`;

export interface ShiftRow {
  id: string;
  label: string;
  starts_at: Date;
  ends_at: Date;
  window_opens_at: Date;
  window_closes_at: Date;
  window_state: string;
  override_expires_at: Date | null;
  report_id: string | null;
  report_status: string | null;
  reference_code: string | null;
}

async function myShifts(q: Queryable, fromSql: string, toSql: string) {
  return q.query<ShiftRow>(
    `select ${SHIFT_COLUMNS},
            app.window_state(s.id, auth.uid()) as window_state,
            (select max(o.expires_at) from public.report_window_overrides o
              where o.shift_id = s.id and o.employee_id = auth.uid() and o.expires_at > now()) as override_expires_at,
            r.id as report_id, r.status as report_status, r.reference_code
       from public.shift_assignments a
       join public.shifts s on s.id = a.shift_id
       join public.departments d on d.id = s.department_id
       left join public.teams t on t.id = s.team_id
       left join public.profiles sup on sup.id = s.supervisor_id
       left join public.shift_reports r on r.shift_id = s.id and r.employee_id = auth.uid()
      where a.employee_id = auth.uid() and a.removed_at is null and s.status = 'scheduled'
        and s.ends_at > now() - ${fromSql} and s.starts_at < now() + ${toSql}
      order by s.starts_at`,
  );
}

const ACTIVE_STATES = new Set(['early_draft', 'open', 'override']);

interface BoardDelivery {
  delivery_id: string;
  shift_id: string;
  outgoing_employee: string;
  acknowledged_at: Date | null;
  approved_content: {
    unresolved_issues?: { issue_id?: string }[];
    pending_actions?: { issue_id?: string }[];
  };
}

interface BoardIssue {
  id: string;
  status: string;
  is_safety: boolean;
}

export function employeeRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/employee/dashboard', async (c) => {
    requireRole(c, 'employee');
    const data = await asUser(c, async (q) => {
      const [{ now }] = (await q.query<{ now: Date }>('select now() as now')) as [{ now: Date }];
      const shifts = await myShifts(q, `interval '24 hours'`, `interval '7 days'`);
      const needsReport = (s: ShiftRow) => !s.report_status || s.report_status === 'draft' || s.report_status === 'revision_requested';
      const current =
        shifts.find((s) => ACTIVE_STATES.has(s.window_state) && needsReport(s)) ??
        shifts.find((s) => ACTIVE_STATES.has(s.window_state)) ??
        shifts.find((s) => s.starts_at <= now && s.window_closes_at > now) ??
        null;
      const upcoming = shifts.filter((s) => s.starts_at > now && s.id !== current?.id).slice(0, 3);
      const missed = shifts.filter(
        (s) => s.window_state === 'closed' && (!s.report_status || s.report_status === 'draft') && s.id !== current?.id,
      );
      const needsRevision = await q.query(
        `select r.id, r.reference_code, s.label, s.shift_date::text as shift_date
           from public.shift_reports r join public.shifts s on s.id = r.shift_id
          where r.employee_id = auth.uid() and r.status = 'revision_requested' order by r.updated_at desc`,
      );
      const incoming = await q.query(
        `select d.id as delivery_id, d.delivered_at, a.report_reference, so.label as outgoing_label, p.full_name as outgoing_employee,
                si.label as incoming_label, si.starts_at as incoming_starts_at,
                k.acknowledged_at
           from public.handover_deliveries d
           join public.handover_approvals a on a.id = d.approval_id
           join public.shifts so on so.id = a.outgoing_shift_id
           join public.shifts si on si.id = d.shift_id
           join public.profiles p on p.id = a.author_id
           left join public.handover_acknowledgments k on k.delivery_id = d.id
          where d.recipient_id = auth.uid() and d.revoked_at is null
            and (k.id is null or d.delivered_at > now() - interval '24 hours')
          order by d.delivered_at desc limit 5`,
      );
      const tasks = await q.query(
        `select i.id, i.code, i.title, i.status, i.severity, i.is_safety, i.last_activity_at,
                (ia.assignee_id = auth.uid()) as assigned_to_me
           from public.operational_issues i
           left join public.issue_assignments ia on ia.issue_id = i.id and ia.ended_at is null
          where i.department_id = app.my_department()
            and i.status in ('reported','pending_verification','open','in_progress','resolution_submitted')
          order by (ia.assignee_id = auth.uid()) desc nulls last, i.is_safety desc,
                   array_position(array['critical','high','medium','low'], i.severity), i.last_activity_at desc
          limit 6`,
      );
      const recent = await q.query(
        `select r.id, r.reference_code, r.status, r.last_submitted_at, s.label, s.shift_date::text as shift_date
           from public.shift_reports r join public.shifts s on s.id = r.shift_id
          where r.employee_id = auth.uid() order by r.created_at desc limit 5`,
      );
      return { server_now: now, current_shift: current, upcoming, missed, needs_revision: needsRevision, incoming, tasks, recent_reports: recent };
    });
    return c.json(data);
  });

  r.get('/employee/shifts', async (c) => {
    requireRole(c, 'employee');
    return c.json(await asUser(c, (q) => myShifts(q, `interval '14 days'`, `interval '14 days'`)));
  });

  r.post('/shifts/:id/report', async (c) => {
    requireRole(c, 'employee');
    const shiftId = idParam(c);
    const id = await asUser(c, async (q) => (await q.query<{ id: string }>('select app.get_or_create_report($1) as id', [shiftId]))[0]!.id);
    return c.json({ report_id: id });
  });

  r.get('/reports/mine', async (c) => {
    requireRole(c, 'employee');
    const rows = await asUser(c, (q) =>
      q.query(
        `select r.id, r.reference_code, r.status, r.current_revision, r.first_submitted_at, r.last_submitted_at, r.is_late,
                r.created_at, s.label, s.shift_date::text as shift_date, s.starts_at, s.ends_at,
                (select a.note from public.handover_approvals a where a.report_id = r.id order by a.decided_at desc limit 1) as latest_note,
                (select a.decided_at from public.handover_approvals a where a.report_id = r.id order by a.decided_at desc limit 1) as decided_at
           from public.shift_reports r join public.shifts s on s.id = r.shift_id
          where r.employee_id = auth.uid() order by s.starts_at desc limit 100`,
      ),
    );
    return c.json(rows);
  });

  // The author's view of a report: their own text, decisions, and the approved version.
  r.get('/reports/:id', async (c) => {
    requireRole(c, 'employee');
    const id = idParam(c);
    const data = await asUser(c, async (q) => {
      const report = await one<Record<string, unknown> & { shift_id: string }>(
        q,
        `select r.id, r.reference_code, r.status, r.draft_content, r.current_revision, r.first_submitted_at, r.last_submitted_at,
                r.is_late, r.analysis_state, r.updated_at, r.shift_id,
                app.window_state(r.shift_id, auth.uid()) as window_state
           from public.shift_reports r where r.id = $1 and r.employee_id = auth.uid()`,
        [id],
      );
      const [shift] = await q.query(
        `select ${SHIFT_COLUMNS},
                (select max(o.expires_at) from public.report_window_overrides o
                  where o.shift_id = s.id and o.employee_id = auth.uid() and o.expires_at > now()) as override_expires_at
           from public.shifts s
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
      const decisions = await q.query(
        `select a.id, a.decision, a.note, a.decided_at, a.revision_no, a.approved_content, p.full_name as reviewer_name
           from public.handover_approvals a join public.profiles p on p.id = a.reviewer_id
          where a.report_id = $1 order by a.decided_at desc`,
        [id],
      );
      const deliveries = await q.query(
        `select d.id, p.full_name as recipient_name, d.delivered_at, k.acknowledged_at
           from public.handover_deliveries d join public.profiles p on p.id = d.recipient_id
           left join public.handover_acknowledgments k on k.delivery_id = d.id
          where d.report_id = $1 and d.revoked_at is null order by p.full_name`,
        [id],
      );
      const issues = await q.query(
        `select id, code, title, status from public.operational_issues
          where department_id = app.my_department()
            and status in ('reported','pending_verification','open','in_progress','resolution_submitted')
          order by created_at desc limit 50`,
      );
      const [{ now }] = (await q.query<{ now: Date }>('select now() as now')) as [{ now: Date }];
      return { report, shift, revisions, decisions, deliveries, open_issues: issues, server_now: now };
    });
    return c.json(data);
  });

  r.put('/reports/:id/draft', async (c) => {
    requireRole(c, 'employee');
    const id = idParam(c);
    const { content } = await parseBody(c, z.object({ content: ReportDraftContent }));
    const savedAt = await asUser(c, async (q) => (await q.query<{ t: Date }>('select app.save_draft($1, $2::jsonb) as t', [id, JSON.stringify(content)]))[0]!.t);
    return c.json({ saved_at: savedAt });
  });

  r.post('/reports/:id/submit', async (c) => {
    requireRole(c, 'employee');
    const id = idParam(c);
    const body = await parseBody(c, z.object({ content: z.unknown() }));
    const parsed = ReportSubmission.safeParse(body.content);
    if (!parsed.success) throw fromZodError(parsed.error);
    const ids = parsed.data.issue_updates.map((u) => u.issue_id);
    if (new Set(ids).size !== ids.length) throw new ApiError(422, 'validation', 'Each existing issue can be updated once per report');
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.submit_report($1, $2::jsonb) as r', [id, JSON.stringify(parsed.data)]))[0]!.r);
    svc(c).kick();
    return c.json(result, 201);
  });

  r.get('/handovers/incoming', async (c) => {
    requireRole(c, 'employee');
    const rows = await asUser(c, (q) =>
      q.query(
        `select d.id as delivery_id, d.delivered_at, a.report_reference, a.approved_content, a.decided_at,
                so.label as outgoing_label, so.shift_date::text as outgoing_date, so.ends_at as outgoing_ended_at,
                si.label as incoming_label, si.starts_at as incoming_starts_at,
                author.full_name as outgoing_employee, reviewer.full_name as reviewer_name,
                k.acknowledged_at, k.note as acknowledgment_note
           from public.handover_deliveries d
           join public.handover_approvals a on a.id = d.approval_id
           join public.shifts so on so.id = a.outgoing_shift_id
           join public.shifts si on si.id = d.shift_id
           join public.profiles author on author.id = a.author_id
           join public.profiles reviewer on reviewer.id = a.reviewer_id
           left join public.handover_acknowledgments k on k.delivery_id = d.id
          where d.recipient_id = auth.uid() and d.revoked_at is null
          order by (k.id is null) desc, d.delivered_at desc limit 30`,
      ),
    );
    // Live status of every problem and task in these handovers: the incoming shift's checklist.
    const ids = rows.flatMap((r) => {
      const content = (r as { approved_content: { unresolved_issues?: { issue_id?: string }[]; pending_actions?: { issue_id?: string }[] } }).approved_content;
      return [...(content.unresolved_issues ?? []), ...(content.pending_actions ?? [])].map((i) => i.issue_id).filter((x): x is string => Boolean(x));
    });
    const items = ids.length
      ? await asUser(c, (q) =>
          q.query<{ id: string }>(
            `select i.id, i.code, i.kind, i.title, i.status, i.severity, i.is_safety,
                    (select count(*)::int from public.issue_photos ph where ph.issue_id = i.id) as photo_count
               from public.operational_issues i where i.id = any($1::uuid[])`,
            [ids],
          ),
        )
      : [];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    return c.json(rows.map((r) => ({ ...r, checklist: byId })));
  });

  // The crew takeover board: for each of my shifts around now, every handover sent to it,
  // one combined checklist (an item reported by several people appears once), who has taken
  // what, and which outgoing workers' handovers are still on the way.
  r.get('/handovers/board', async (c) => {
    requireRole(c, 'employee');
    const data = await asUser(c, async (q) => {
      const [{ now }] = (await q.query<{ now: Date }>('select now() as now')) as [{ now: Date }];
      const deliveries = await q.query<BoardDelivery>(
        `select d.id as delivery_id, d.shift_id, d.delivered_at, a.report_reference, a.approved_content, a.decided_at,
                so.label as outgoing_label, so.shift_date::text as outgoing_date, so.ends_at as outgoing_ended_at,
                author.full_name as outgoing_employee, reviewer.full_name as reviewer_name,
                k.acknowledged_at, k.note as acknowledgment_note
           from public.handover_deliveries d
           join public.handover_approvals a on a.id = d.approval_id
           join public.shifts so on so.id = a.outgoing_shift_id
           join public.profiles author on author.id = a.author_id
           join public.profiles reviewer on reviewer.id = a.reviewer_id
           left join public.handover_acknowledgments k on k.delivery_id = d.id
          where d.recipient_id = auth.uid() and d.revoked_at is null
          order by d.delivered_at desc limit 60`,
      );
      const shifts = await q.query<{ id: string; label: string; starts_at: Date; ends_at: Date; timezone: string }>(
        `select s.id, s.label, s.starts_at, s.ends_at, s.timezone from public.shifts s
          where s.status = 'scheduled' and (
                  (exists (select 1 from public.shift_assignments a where a.shift_id = s.id and a.employee_id = auth.uid() and a.removed_at is null)
                   and s.ends_at > now() - interval '12 hours' and s.starts_at < now() + interval '24 hours')
                  or s.id = any($1::uuid[]))
          order by (s.ends_at < now()), s.starts_at`,
        [deliveries.filter((d) => !d.acknowledged_at).map((d) => d.shift_id)],
      );
      const shiftIds = new Set(shifts.map((s) => s.id));

      // Merge every problem and task across the handovers of one shift; remember who mentioned it.
      const merged = new Map<string, Map<string, Set<string>>>();
      for (const d of deliveries) {
        if (!shiftIds.has(d.shift_id)) continue;
        const items = merged.get(d.shift_id) ?? new Map<string, Set<string>>();
        merged.set(d.shift_id, items);
        for (const i of [...(d.approved_content.unresolved_issues ?? []), ...(d.approved_content.pending_actions ?? [])]) {
          if (i.issue_id) items.set(i.issue_id, (items.get(i.issue_id) ?? new Set<string>()).add(d.outgoing_employee));
        }
      }
      const listed = [...merged.values()].flatMap((m) => [...m.keys()]);
      const issues = await q.query<BoardIssue>(
        `select i.id, i.code, i.kind, i.title, i.status, i.severity, i.is_safety, i.created_at,
                ia.assignee_id as owner_id, ap.full_name as owner_name,
                (select count(*)::int from public.issue_photos ph where ph.issue_id = i.id) as photo_count
           from public.operational_issues i
           left join public.issue_assignments ia on ia.issue_id = i.id and ia.ended_at is null
           left join public.profiles ap on ap.id = ia.assignee_id
          where i.id = any($1::uuid[])
             or (i.department_id = app.my_department()
                 and i.status in ('reported','pending_verification','open','in_progress','resolution_submitted'))
          order by (ia.assignee_id = auth.uid()) desc nulls last, i.is_safety desc,
                   array_position(array['critical','high','medium','low'], i.severity), i.last_activity_at desc`,
        [listed],
      );
      const byId = new Map(issues.map((i) => [i.id, i]));
      const rank = (i: BoardIssue) => (i.status === 'resolved' || i.status === 'closed' ? 2 : i.status === 'resolution_submitted' ? 1 : 0);

      const board = [];
      for (const s of shifts) {
        const outgoing = await q.query('select * from app.turnover_status($1)', [s.id]);
        const items = [...(merged.get(s.id) ?? new Map<string, Set<string>>()).entries()]
          .map(([id, from]) => (byId.has(id) ? { ...byId.get(id)!, from: [...from].sort() } : null))
          .filter((x): x is BoardIssue & { from: string[] } => x !== null)
          .sort((a, b) => rank(a) - rank(b) || Number(b.is_safety) - Number(a.is_safety));
        board.push({
          ...s,
          is_now: s.starts_at <= now && s.ends_at > now,
          outgoing,
          handovers: deliveries.filter((d) => d.shift_id === s.id),
          checklist: items,
        });
      }
      const listedSet = new Set(listed);
      const carriedOver = issues
        .filter((i) => !listedSet.has(i.id) && ['open', 'in_progress', 'resolution_submitted'].includes(i.status))
        .slice(0, 12);
      const earlier = deliveries.filter((d) => !shiftIds.has(d.shift_id)).slice(0, 10);
      return { server_now: now, shifts: board, carried_over: carriedOver, earlier };
    });
    return c.json(data);
  });

  r.post('/issues/:id/claim', async (c) => {
    requireRole(c, 'employee');
    const id = idParam(c);
    const { take } = await parseBody(c, z.strictObject({ take: z.boolean() }));
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.claim_issue($1, $2) as r', [id, take]))[0]!.r);
    return c.json(result);
  });

  r.post('/handovers/:id/acknowledge', async (c) => {
    requireRole(c, 'employee');
    const id = idParam(c);
    const { note } = await parseBody(c, z.object({ note: z.string().trim().max(500).default('') }));
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.acknowledge_handover($1, $2) as r', [id, note]))[0]!.r);
    return c.json(result);
  });

  return r;
}
