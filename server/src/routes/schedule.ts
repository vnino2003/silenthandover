import { Hono } from 'hono';
import { z } from 'zod';
import { createDemoTimeline } from '../seed/demo';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, svc, type AppEnv } from '../http/context';

/**
 * Shift scheduling for supervisors. Mounted under /manager, so only managers reach it,
 * and every database function checks the shift belongs to the caller's own department.
 */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const optionalUuid = z.uuid().nullable().default(null);

const TemplateBody = z.strictObject({
  team_id: optionalUuid,
  name: z.string().trim().min(2).max(80),
  start_time: time,
  end_time: time,
  window_open_minutes: z.number().int().min(5).max(240),
  grace_minutes: z.number().int().min(0).max(240),
  allow_early_draft: z.boolean().default(true),
  is_active: z.boolean().default(true),
});

const templateSql = 'select app.upsert_shift_template($1, $2, $3, $4::time, $5::time, $6, $7, $8, $9) as id';
const templateParams = (id: string | null, b: z.infer<typeof TemplateBody>) => [
  id,
  b.team_id,
  b.name,
  b.start_time,
  b.end_time,
  b.window_open_minutes,
  b.grace_minutes,
  b.allow_early_draft,
  b.is_active,
];

export function scheduleRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/templates', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select t.id, t.team_id, tm.name as team_name, t.name,
                to_char(t.start_time, 'HH24:MI') as start_time, to_char(t.end_time, 'HH24:MI') as end_time,
                t.end_time <= t.start_time as overnight, t.window_open_minutes, t.grace_minutes, t.allow_early_draft, t.is_active
           from public.shift_templates t
           left join public.teams tm on tm.id = t.team_id
          where t.department_id = app.my_department()
          order by t.start_time`,
      ),
    );
    return c.json(rows);
  });

  r.post('/templates', async (c) => {
    const b = await parseBody(c, TemplateBody);
    const id = await asUser(c, async (q) => (await q.query<{ id: string }>(templateSql, templateParams(null, b)))[0]!.id);
    return c.json({ id }, 201);
  });

  r.patch('/templates/:id', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, TemplateBody);
    await asUser(c, (q) => q.query(templateSql, templateParams(id, b)));
    return c.json({ ok: true });
  });

  r.post('/templates/:id/generate', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ from: z.iso.date(), to: z.iso.date(), supervisor_id: optionalUuid }));
    const created = await asUser(c, async (q) =>
      (await q.query<{ n: number }>('select app.generate_shifts($1, $2::date, $3::date, $4) as n', [id, b.from, b.to, b.supervisor_id]))[0]!.n,
    );
    return c.json({ created });
  });

  r.get('/schedule', async (c) => {
    const query = parseQuery(c, z.object({ from: z.iso.date(), to: z.iso.date() }));
    const rows = await asUser(c, (q) =>
      q.query(
        `select s.id, s.label, s.shift_date::text as shift_date, s.timezone, s.status, s.starts_at, s.ends_at,
                s.window_opens_at, s.window_closes_at, s.team_id, t.name as team_name,
                s.supervisor_id, sup.full_name as supervisor_name, s.template_id,
                coalesce((select jsonb_agg(jsonb_build_object('employee_id', p.id, 'full_name', p.full_name) order by p.full_name)
                            from public.shift_assignments a join public.profiles p on p.id = a.employee_id
                           where a.shift_id = s.id and a.removed_at is null), '[]'::jsonb) as assignees
           from public.shifts s
           left join public.teams t on t.id = s.team_id
           left join public.profiles sup on sup.id = s.supervisor_id
          where s.department_id = app.my_department() and s.shift_date between $1::date and $2::date
          order by s.starts_at`,
        [query.from, query.to],
      ),
    );
    return c.json(rows);
  });

  r.post('/schedule', async (c) => {
    const b = await parseBody(
      c,
      z.strictObject({
        team_id: optionalUuid,
        label: z.string().trim().min(2).max(80),
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        window_open_minutes: z.number().int().min(5).max(240).default(30),
        grace_minutes: z.number().int().min(0).max(240).default(30),
        supervisor_id: optionalUuid,
        allow_early_draft: z.boolean().default(true),
      }),
    );
    const id = await asUser(c, async (q) =>
      (await q.query<{ id: string }>('select app.create_shift($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8) as id', [
        b.team_id,
        b.label,
        b.starts_at,
        b.ends_at,
        b.window_open_minutes,
        b.grace_minutes,
        b.supervisor_id,
        b.allow_early_draft,
      ]))[0]!.id,
    );
    return c.json({ id }, 201);
  });

  r.patch('/schedule/:id', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ supervisor_id: optionalUuid, status: z.enum(['scheduled', 'cancelled']) }));
    await asUser(c, (q) => q.query('select app.update_shift($1, $2, $3)', [id, b.supervisor_id, b.status]));
    return c.json({ ok: true });
  });

  r.post('/schedule/:id/assignments', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ employee_id: z.uuid() }));
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.assign_to_shift($1, $2) as r', [id, b.employee_id]))[0]!.r);
    svc(c).kick();
    return c.json(result, 201);
  });

  r.delete('/schedule/:id/assignments/:employeeId', async (c) => {
    const id = idParam(c);
    const employeeId = idParam(c, 'employeeId');
    await asUser(c, (q) => q.query('select app.unassign_from_shift($1, $2)', [id, employeeId]));
    return c.json({ ok: true });
  });

  // LOCAL DEMO ONLY: a fresh outgoing/incoming shift pair whose reporting window is open now.
  r.post('/demo/timeline', async (c) => {
    const { config } = svc(c);
    if (config.APP_MODE !== 'local' || !config.DEMO_MODE) throw new ApiError(404, 'not_found', 'Not found');
    return c.json(await createDemoTimeline(svc(c), c.get('userId')), 201);
  });

  return r;
}
