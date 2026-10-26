import { Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '@sh/shared';
import { maskAddress } from '../automation/notifications';
import { createDemoTimeline } from '../seed/demo';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, svc, type AppEnv } from '../http/context';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const optionalUuid = z.uuid().nullable().default(null);

const UserFields = z.strictObject({
  full_name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  department_id: optionalUuid,
  team_id: optionalUuid,
  phone: z
    .string()
    .trim()
    .regex(/^(\+?[0-9 -]{7,20})?$/, 'Enter a valid phone number')
    .nullable()
    .default(null),
});

export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    requireRole(c, 'admin');
    await next();
  });

  // ---- Users ---------------------------------------------------------------
  r.get('/users', async (c) => c.json(await asUser(c, async (q) => (await q.query<{ u: unknown }>('select app.admin_list_users() as u'))[0]!.u)));

  r.post('/users', async (c) => {
    const body = await parseBody(
      c,
      UserFields.extend({
        email: z.email().max(200),
        password: z.string().min(10, 'Use at least 10 characters').max(200),
      }),
    );
    if (body.role !== 'admin' && !body.department_id) throw new ApiError(422, 'validation', 'Choose a department', { department_id: 'Required' });
    // Confirm admin rights before creating a sign-in identity (the database checks again).
    requireRole(c, 'admin');
    const userId = await svc(c).auth.createUser(body.email, body.password);
    await asUser(c, (q) =>
      q.query('select app.admin_create_profile($1, $2, $3, $4, $5, $6, $7)', [
        userId,
        body.full_name,
        body.email,
        body.role,
        body.department_id,
        body.team_id,
        body.phone,
      ]),
    );
    return c.json({ id: userId }, 201);
  });

  r.patch('/users/:id', async (c) => {
    const id = idParam(c);
    const body = await parseBody(c, UserFields.extend({ is_active: z.boolean() }));
    await asUser(c, (q) =>
      q.query('select app.admin_update_user($1, $2, $3, $4, $5, $6, $7)', [
        id,
        body.full_name,
        body.role,
        body.department_id,
        body.team_id,
        body.phone,
        body.is_active,
      ]),
    );
    return c.json({ ok: true });
  });

  // ---- Departments and teams ---------------------------------------------------
  r.get('/departments', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select d.id, d.code, d.name, d.timezone, d.created_at,
                coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name) from public.teams t where t.department_id = d.id), '[]'::jsonb) as teams,
                (select count(*)::int from public.profiles p where p.department_id = d.id and p.is_active) as member_count
           from public.departments d order by d.name`,
      ),
    );
    return c.json(rows);
  });

  const DepartmentBody = z.strictObject({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, '2–12 letters, digits or dashes'),
    name: z.string().trim().min(2).max(120),
    timezone: z.string().trim().min(2).max(64),
  });
  r.post('/departments', async (c) => {
    const b = await parseBody(c, DepartmentBody);
    const id = await asUser(c, async (q) => (await q.query<{ id: string }>('select app.admin_upsert_department(null, $1, $2, $3) as id', [b.code, b.name, b.timezone]))[0]!.id);
    return c.json({ id }, 201);
  });
  r.patch('/departments/:id', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, DepartmentBody);
    await asUser(c, (q) => q.query('select app.admin_upsert_department($1, $2, $3, $4)', [id, b.code, b.name, b.timezone]));
    return c.json({ ok: true });
  });
  r.post('/departments/:id/teams', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ name: z.string().trim().min(2).max(120) }));
    const teamId = await asUser(c, async (q) => (await q.query<{ id: string }>('select app.admin_upsert_team(null, $1, $2) as id', [id, b.name]))[0]!.id);
    return c.json({ id: teamId }, 201);
  });

  // ---- Shift templates -------------------------------------------------------
  const TemplateBody = z.strictObject({
    department_id: z.uuid(),
    team_id: optionalUuid,
    name: z.string().trim().min(2).max(80),
    start_time: time,
    end_time: time,
    window_open_minutes: z.number().int().min(5).max(240),
    grace_minutes: z.number().int().min(0).max(240),
    allow_early_draft: z.boolean().default(true),
    is_active: z.boolean().default(true),
  });
  r.get('/templates', async (c) => {
    const rows = await asUser(c, (q) =>
      q.query(
        `select t.id, t.department_id, d.name as department_name, t.team_id, tm.name as team_name, t.name,
                to_char(t.start_time, 'HH24:MI') as start_time, to_char(t.end_time, 'HH24:MI') as end_time,
                t.end_time <= t.start_time as overnight, t.window_open_minutes, t.grace_minutes, t.allow_early_draft, t.is_active
           from public.shift_templates t
           join public.departments d on d.id = t.department_id
           left join public.teams tm on tm.id = t.team_id
          order by d.name, t.start_time`,
      ),
    );
    return c.json(rows);
  });
  const saveTemplate = (id: string | null, b: z.infer<typeof TemplateBody>) => [
    id,
    b.department_id,
    b.team_id,
    b.name,
    b.start_time,
    b.end_time,
    b.window_open_minutes,
    b.grace_minutes,
    b.allow_early_draft,
    b.is_active,
  ];
  const templateSql = 'select app.admin_upsert_template($1, $2, $3, $4, $5::time, $6::time, $7, $8, $9, $10) as id';
  r.post('/templates', async (c) => {
    const b = await parseBody(c, TemplateBody);
    const id = await asUser(c, async (q) => (await q.query<{ id: string }>(templateSql, saveTemplate(null, b)))[0]!.id);
    return c.json({ id }, 201);
  });
  r.patch('/templates/:id', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, TemplateBody);
    await asUser(c, (q) => q.query(templateSql, saveTemplate(id, b)));
    return c.json({ ok: true });
  });
  r.post('/templates/:id/generate', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ from: z.iso.date(), to: z.iso.date(), supervisor_id: optionalUuid }));
    const created = await asUser(c, async (q) =>
      (await q.query<{ n: number }>('select app.admin_generate_shifts($1, $2::date, $3::date, $4) as n', [id, b.from, b.to, b.supervisor_id]))[0]!.n,
    );
    return c.json({ created });
  });

  // ---- Shifts and assignments -------------------------------------------------
  r.get('/shifts', async (c) => {
    const query = parseQuery(c, z.object({ department_id: z.uuid().optional(), from: z.iso.date(), to: z.iso.date() }));
    const rows = await asUser(c, (q) =>
      q.query(
        `select s.id, s.label, s.shift_date::text as shift_date, s.timezone, s.status, s.starts_at, s.ends_at,
                s.window_opens_at, s.window_closes_at, s.department_id, d.name as department_name, s.team_id, t.name as team_name,
                s.supervisor_id, sup.full_name as supervisor_name, s.template_id,
                coalesce((select jsonb_agg(jsonb_build_object('employee_id', p.id, 'full_name', p.full_name) order by p.full_name)
                            from public.shift_assignments a join public.profiles p on p.id = a.employee_id
                           where a.shift_id = s.id and a.removed_at is null), '[]'::jsonb) as assignees
           from public.shifts s
           join public.departments d on d.id = s.department_id
           left join public.teams t on t.id = s.team_id
           left join public.profiles sup on sup.id = s.supervisor_id
          where ($1::uuid is null or s.department_id = $1) and s.shift_date between $2::date and $3::date
          order by s.starts_at`,
        [query.department_id ?? null, query.from, query.to],
      ),
    );
    return c.json(rows);
  });

  r.post('/shifts', async (c) => {
    const b = await parseBody(
      c,
      z.strictObject({
        department_id: z.uuid(),
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
      (await q.query<{ id: string }>('select app.admin_create_shift($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9) as id', [
        b.department_id,
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

  r.patch('/shifts/:id', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ supervisor_id: optionalUuid, status: z.enum(['scheduled', 'cancelled']) }));
    await asUser(c, (q) => q.query('select app.admin_update_shift($1, $2, $3)', [id, b.supervisor_id, b.status]));
    return c.json({ ok: true });
  });

  r.post('/shifts/:id/assignments', async (c) => {
    const id = idParam(c);
    const b = await parseBody(c, z.strictObject({ employee_id: z.uuid() }));
    const result = await asUser(c, async (q) => (await q.query<{ r: unknown }>('select app.admin_assign_employee($1, $2) as r', [id, b.employee_id]))[0]!.r);
    svc(c).kick();
    return c.json(result, 201);
  });

  r.delete('/shifts/:id/assignments/:employeeId', async (c) => {
    const id = idParam(c);
    const employeeId = idParam(c, 'employeeId');
    await asUser(c, (q) => q.query('select app.admin_unassign_employee($1, $2)', [id, employeeId]));
    return c.json({ ok: true });
  });

  // ---- Settings and templates -------------------------------------------------
  r.get('/settings', async (c) =>
    c.json(await asUser(c, (q) => q.query('select key, value, description, updated_at from public.app_settings order by key'))),
  );
  r.put('/settings/:key', async (c) => {
    const key = c.req.param('key');
    const b = await parseBody(c, z.strictObject({ value: z.union([z.number().int().min(0).max(10000), z.boolean()]) }));
    await asUser(c, (q) => q.query('select app.admin_set_setting($1, $2::jsonb)', [key, JSON.stringify(b.value)]));
    return c.json({ ok: true });
  });
  r.get('/notification-templates', async (c) =>
    c.json(await asUser(c, (q) => q.query('select key, subject, body, updated_at from public.notification_templates order by key'))),
  );
  r.put('/notification-templates/:key', async (c) => {
    const key = c.req.param('key');
    const b = await parseBody(c, z.strictObject({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(4000) }));
    await asUser(c, (q) => q.query('select app.admin_set_template($1, $2, $3)', [key, b.subject, b.body]));
    return c.json({ ok: true });
  });

  // ---- Integrations and automation health ---------------------------------------
  r.get('/integrations', async (c) => {
    const { config, analysis, notifications } = svc(c);
    const data = await asUser(c, async (q) => {
      const eventCounts = await q.query(
        `select kind, status, count(*)::int as count from public.automation_events
          where created_at > now() - interval '7 days' group by kind, status order by kind, status`,
      );
      const events = await q.query(
        `select e.id, e.kind, e.status, e.adapter, e.attempts, e.max_attempts, e.next_attempt_at, e.dispatched_at, e.completed_at,
                e.last_error, e.created_at, e.idempotency_key, d.name as department_name
           from public.automation_events e left join public.departments d on d.id = e.department_id
          order by e.created_at desc limit 50`,
      );
      const deliveryCounts = await q.query(
        `select channel, status, count(*)::int as count from public.notification_deliveries
          where created_at > now() - interval '7 days' group by channel, status order by channel, status`,
      );
      const deliveries = await q.query<{ id: string; recipient_id: string; status: string }>(
        `select d.id, d.channel, d.status, d.provider, d.provider_message_id, d.attempts, d.max_attempts, d.last_error,
                d.created_at, d.updated_at, d.recipient_id, p.full_name as recipient_name
           from public.notification_deliveries d join public.profiles p on p.id = d.recipient_id
          order by d.created_at desc limit 50`,
      );
      const overview = (await q.query<{ o: unknown }>('select app.admin_report_overview() as o'))[0]!.o;
      return { eventCounts, events, deliveryCounts, deliveries, overview };
    });
    // Dev outbox: what *would* have been emailed. Addresses are masked; nothing was sent.
    const outbox =
      notifications.transportName === 'dev'
        ? await svc(c).db.asService((q) =>
            q.query<{ address: string; provider_response: { subject?: string; preview?: string } | null }>(
              `select d.id, d.address, d.provider_response, d.updated_at from public.notification_deliveries d
                where d.status = 'simulated' order by d.updated_at desc limit 25`,
            ),
          )
        : [];
    return c.json({
      adapters: {
        ai: {
          adapter: analysis.adapterName,
          simulated: analysis.adapterName === 'dev',
          webhook_configured: Boolean(config.N8N_ANALYSIS_WEBHOOK_URL),
          prompt_version: config.PROMPT_VERSION,
        },
        email: { transport: notifications.transportName, simulated: notifications.transportName === 'dev', from: config.EMAIL_FROM },
        sms: { connected: false, note: 'SMS provider interface exists; no provider is connected.' },
        callbacks: { enabled: Boolean(config.N8N_CALLBACK_SECRET) },
        scheduler: { internal: config.ENABLE_INTERNAL_SCHEDULER, interval_ms: config.SCHEDULER_INTERVAL_MS },
      },
      ...data,
      outbox: outbox.map((o) => ({ ...o, address: maskAddress(o.address) })),
    });
  });

  r.post('/events/:id/retry', async (c) => {
    const id = idParam(c);
    await asUser(c, (q) => q.query('select app.admin_retry_event($1)', [id]));
    svc(c).kick();
    return c.json({ ok: true });
  });

  r.post('/deliveries/:id/retry', async (c) => {
    const id = idParam(c);
    await asUser(c, (q) => q.query('select app.admin_retry_delivery($1)', [id]));
    svc(c).kick();
    return c.json({ ok: true });
  });

  // LOCAL DEMO ONLY: a fresh outgoing/incoming shift pair whose reporting window is open now.
  r.post('/demo/timeline', async (c) => {
    const { config } = svc(c);
    if (config.APP_MODE !== 'local' || !config.DEMO_MODE) throw new ApiError(404, 'not_found', 'Not found');
    return c.json(await createDemoTimeline(svc(c), c.get('userId')), 201);
  });

  r.post('/tick', async (c) => {
    const result = await svc(c).db.asService(async (q) => (await q.query<{ r: unknown }>('select internal.scheduled_tick() as r'))[0]!.r);
    svc(c).kick();
    return c.json(result);
  });

  return r;
}
