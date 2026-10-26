import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, type AppEnv } from '../http/context';

export function meRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/me', (c) => c.json(c.get('profile')));

  r.patch('/me/preferences', async (c) => {
    const body = await parseBody(
      c,
      z.strictObject({
        notify_email: z.boolean(),
        notify_sms: z.boolean(),
        phone: z
          .string()
          .trim()
          .max(20)
          .regex(/^(\+?[0-9 -]{7,20})?$/, 'Enter a valid phone number')
          .nullable(),
      }),
    );
    await asUser(c, (q) => q.query('select app.update_my_preferences($1, $2, $3)', [body.notify_email, body.notify_sms, body.phone]));
    return c.json(await asUser(c, async (q) => (await q.query<{ p: unknown }>('select app.my_profile() as p'))[0]!.p));
  });

  // Your own profile picture: set or remove it. The browser crops and shrinks it first.
  r.put('/me/photo', async (c) => {
    const body = await parseBody(
      c,
      z.strictObject({
        content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        data_base64: z.string().max(700_000, 'Pictures must be 512 KB or smaller').regex(/^[A-Za-z0-9+/]+=*$/, 'The picture could not be read'),
      }),
    );
    await asUser(c, (q) => q.query('select app.set_my_photo($1, $2)', [body.content_type, body.data_base64]));
    return c.json(await asUser(c, async (q) => (await q.query<{ p: unknown }>('select app.my_profile() as p'))[0]!.p));
  });

  r.delete('/me/photo', async (c) => {
    await asUser(c, (q) => q.query('select app.remove_my_photo()'));
    return c.json(await asUser(c, async (q) => (await q.query<{ p: unknown }>('select app.my_profile() as p'))[0]!.p));
  });

  // Served through the API so RLS decides who may see it; the URL carries no token.
  r.get('/profile-photos/:id', async (c) => {
    const id = idParam(c);
    const [photo] = await asUser(c, (q) =>
      q.query<{ content_type: string; data: Uint8Array }>('select content_type, data from public.profile_photos where profile_id = $1', [id]),
    );
    if (!photo) throw new ApiError(404, 'not_found', 'No picture');
    return c.body(new Uint8Array(photo.data), 200, {
      'Content-Type': photo.content_type,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  r.get('/notifications', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select id, kind, title, body, link, read_at, created_at from public.notifications
          where recipient_id = auth.uid() order by created_at desc limit 50`,
      ),
    );
    const unread = rows.filter((n) => !(n as { read_at: unknown }).read_at).length;
    return c.json({ items: rows, unread });
  });

  r.post('/notifications/read', async (c) => {
    const body = await parseBody(c, z.strictObject({ ids: z.array(z.uuid()).max(100).nullable() }));
    const count = await asUser(c, async (q) => (await q.query<{ n: number }>('select app.mark_notifications_read($1::uuid[]) as n', [body.ids]))[0]!.n);
    return c.json({ updated: count });
  });

  // Colleagues in the caller's department (names and roles only — RLS + column grants).
  r.get('/department/staff', async (c) => {
    requireRole(c, 'employee', 'manager');
    const rows = await asUser(c, (q) =>
      q.query(
        `select id, full_name, role from public.profiles
          where department_id = app.my_department() and is_active order by role desc, full_name`,
      ),
    );
    return c.json(rows);
  });

  r.get('/audit', async (c) => {
    requireRole(c, 'manager', 'admin');
    const query = parseQuery(
      c,
      z.object({
        entity_type: z.string().max(40).optional(),
        entity_id: z.uuid().optional(),
        action: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    );
    const rows = await asUser(c, (q) =>
      q.query(
        `select l.id::text, l.actor_role, l.action, l.entity_type, l.entity_id, l.department_id, d.name as department_name,
                l.details, l.created_at, p.full_name as actor_name
           from public.audit_logs l
           left join public.profiles p on p.id = l.actor_id
           left join public.departments d on d.id = l.department_id
          where ($1::text is null or l.entity_type = $1)
            and ($2::uuid is null or l.entity_id = $2)
            and ($3::text is null or l.action like $3 || '%')
          order by l.created_at desc, l.id desc limit $4`,
        [query.entity_type ?? null, query.entity_id ?? null, query.action ?? null, query.limit],
      ),
    );
    return c.json(rows);
  });

  return r;
}
