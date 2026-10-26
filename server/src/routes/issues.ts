import { Hono } from 'hono';
import { z } from 'zod';
import { ISSUE_SEVERITIES, ISSUE_STATUSES } from '@sh/shared';
import { asUser, idParam, one, parseBody, parseQuery, requireRole, type AppEnv } from '../http/context';

export function issueRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/issues', async (c) => {
    requireRole(c, 'employee', 'manager');
    const query = parseQuery(
      c,
      z.object({
        scope: z.enum(['active', 'all', 'mine', 'verification']).default('active'),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    );
    const rows = await asUser(c, (q) =>
      q.query(
        `select i.id, i.code, i.title, i.description, i.severity, i.is_safety, i.status, i.created_at, i.last_activity_at,
                i.escalated_at, i.resolved_at, ia.assignee_id, ap.full_name as assignee_name,
                (select count(*)::int from public.issue_updates u where u.issue_id = i.id) as update_count
           from public.operational_issues i
           left join public.issue_assignments ia on ia.issue_id = i.id and ia.ended_at is null
           left join public.profiles ap on ap.id = ia.assignee_id
          where i.department_id = app.my_department()
            and case $1
                  when 'active' then i.status in ('reported','pending_verification','open','in_progress','resolution_submitted')
                  when 'mine' then ia.assignee_id = auth.uid() and i.status not in ('resolved','closed')
                  when 'verification' then i.status in ('reported','pending_verification','resolution_submitted')
                  else true end
          order by i.is_safety desc, array_position(array['critical','high','medium','low'], i.severity), i.last_activity_at desc
          limit $2`,
        [query.scope, query.limit],
      ),
    );
    return c.json(rows);
  });

  r.get('/issues/:id', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const data = await asUser(c, async (q) => {
      const issue = await one(
        q,
        `select i.*, ia.assignee_id, ap.full_name as assignee_name, cp.full_name as created_by_name, rp.full_name as resolved_by_name
           from public.operational_issues i
           left join public.issue_assignments ia on ia.issue_id = i.id and ia.ended_at is null
           left join public.profiles ap on ap.id = ia.assignee_id
           left join public.profiles cp on cp.id = i.created_by
           left join public.profiles rp on rp.id = i.resolved_by
          where i.id = $1`,
        [id],
      );
      const updates = await q.query(
        `select u.id, u.kind, u.from_status, u.to_status, u.note, u.created_at, p.full_name as author_name, p.role as author_role
           from public.issue_updates u left join public.profiles p on p.id = u.author_id
          where u.issue_id = $1 order by u.created_at, u.id`,
        [id],
      );
      return { issue, updates };
    });
    return c.json(data);
  });

  r.post('/issues', async (c) => {
    requireRole(c, 'employee', 'manager');
    const body = await parseBody(
      c,
      z.strictObject({
        title: z.string().trim().min(3).max(160),
        description: z.string().trim().max(2000).default(''),
        severity: z.enum(ISSUE_SEVERITIES),
        is_safety: z.boolean().default(false),
      }),
    );
    const result = await asUser(c, async (q) =>
      (await q.query<{ r: unknown }>('select app.raise_issue($1, $2, $3, $4) as r', [body.title, body.description, body.severity, body.is_safety]))[0]!.r,
    );
    return c.json(result, 201);
  });

  r.post('/issues/:id/transition', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ to: z.enum(ISSUE_STATUSES), note: z.string().trim().max(2000).default('') }));
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.transition_issue($1, $2, $3) as r', [id, body.to, body.note]))[0]!.r);
    return c.json(result);
  });

  r.post('/issues/:id/notes', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ note: z.string().trim().min(3).max(2000) }));
    await asUser(c, (q) => q.query('select app.add_issue_note($1, $2)', [id, body.note]));
    return c.json({ ok: true }, 201);
  });

  r.post('/issues/:id/assign', async (c) => {
    requireRole(c, 'manager');
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ assignee_id: z.uuid().nullable() }));
    await asUser(c, (q) => q.query('select app.assign_issue($1, $2)', [id, body.assignee_id]));
    return c.json({ ok: true });
  });

  return r;
}
