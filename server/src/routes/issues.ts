import { Hono } from 'hono';
import { z } from 'zod';
import { ISSUE_SEVERITIES, ISSUE_STATUSES } from '@sh/shared';
import { ApiError } from '../http/errors';
import { asUser, idParam, one, parseBody, parseQuery, requireRole, type AppEnv } from '../http/context';
import type { Queryable } from '../db/types';

/** Optional photo proof, compressed in the browser and sent as base64 (≤ 3 MB decoded). */
const Photo = z
  .strictObject({
    content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    data_base64: z
      .string()
      .max(4_200_000, 'Photos must be 3 MB or smaller')
      .regex(/^[A-Za-z0-9+/]+=*$/, 'The photo could not be read'),
  })
  .nullable()
  .default(null);

async function attachPhoto(q: Queryable, issueId: string, updateId: string | null, photo: z.infer<typeof Photo>) {
  if (!photo) return null;
  const [row] = await q.query<{ id: string }>('select app.add_issue_photo($1, $2, $3, $4) as id', [issueId, updateId, photo.content_type, photo.data_base64]);
  return row!.id;
}

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
        `select i.id, i.code, i.kind, i.title, i.description, i.severity, i.is_safety, i.status, i.created_at, i.last_activity_at,
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
      const photos = await q.query(
        `select ph.id, ph.update_id, ph.created_at, p.full_name as uploaded_by_name
           from public.issue_photos ph left join public.profiles p on p.id = ph.uploaded_by
          where ph.issue_id = $1 order by ph.created_at`,
        [id],
      );
      return { issue, updates, photos };
    });
    return c.json(data);
  });

  // Photos are served through the API so RLS decides who can see them; links carry no tokens.
  r.get('/issue-photos/:id', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const [photo] = await asUser(c, (q) =>
      q.query<{ content_type: string; data: Uint8Array }>('select content_type, data from public.issue_photos where id = $1', [id]),
    );
    if (!photo) throw new ApiError(404, 'not_found', 'Photo not found');
    return c.body(new Uint8Array(photo.data), 200, {
      'Content-Type': photo.content_type,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
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
    const body = await parseBody(c, z.strictObject({ to: z.enum(ISSUE_STATUSES), note: z.string().trim().max(2000).default(''), photo: Photo }));
    const result = await asUser(c, async (q) => {
      const r = (await q.query<{ r: { id: string; status: string; update_id: string } }>('select app.transition_issue($1, $2, $3) as r', [id, body.to, body.note]))[0]!.r;
      const photo_id = await attachPhoto(q, id, r.update_id, body.photo);
      return { ...r, photo_id };
    });
    return c.json(result);
  });

  r.post('/issues/:id/notes', async (c) => {
    requireRole(c, 'employee', 'manager');
    const id = idParam(c);
    const body = await parseBody(c, z.strictObject({ note: z.string().trim().min(3).max(2000), photo: Photo }));
    await asUser(c, async (q) => {
      const [u] = await q.query<{ id: string }>('select app.add_issue_note($1, $2) as id', [id, body.note]);
      await attachPhoto(q, id, u!.id, body.photo);
    });
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
