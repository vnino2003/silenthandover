import { Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '@sh/shared';
import { maskAddress } from '../automation/notifications';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, svc, type AppEnv } from '../http/context';
import { resetActivity } from '../seed/demo';
import { AI_PROVIDERS, callProvider, ProviderError } from '../automation/ai-provider';

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

  // ---- AI provider -------------------------------------------------------------
  // The administrator picks Gemini or Grok and pastes the API key here. The key is encrypted
  // before it is stored and is never sent back: responses only say whether one is saved.
  r.get('/ai', async (c) => {
    const { aiSettings, config } = svc(c);
    return c.json({ ...(await aiSettings.view()), adapter: config.AI_ADAPTER, providers: AI_PROVIDERS });
  });

  const AiBody = z.strictObject({
    provider: z.enum(['simulator', 'gemini', 'grok']),
    model: z.string().trim().min(2).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'Use the model name exactly as the provider lists it').nullable().default(null),
    // A new key replaces the saved one; null removes it; leaving it out keeps it.
    api_key: z.string().trim().min(16, 'That does not look like a full API key').max(300).nullable().optional(),
  });

  r.put('/ai', async (c) => {
    const b = await parseBody(c, AiBody);
    const { aiSettings } = svc(c);
    const view = await aiSettings.view();
    if (b.api_key && !view.encryption_available) {
      throw new ApiError(409, 'encryption_unavailable', 'Set SECRETS_ENCRYPTION_KEY on the server before saving an API key');
    }
    if (b.provider !== 'simulator' && !b.api_key && !(view.has_key && view.provider === b.provider && b.api_key === undefined)) {
      throw new ApiError(422, 'validation', 'Paste the API key for this provider', { api_key: 'Required' });
    }
    await aiSettings.save({ provider: b.provider, model: b.provider === 'simulator' ? null : b.model, apiKey: b.api_key }, c.get('userId'));
    return c.json(await aiSettings.view());
  });

  // Sends a tiny request with the saved key (or one being tried before saving) to prove it works.
  r.post('/ai/test', async (c) => {
    const b = await parseBody(c, AiBody.extend({ provider: z.enum(['gemini', 'grok']) }));
    const { aiSettings, config, fetchImpl } = svc(c);
    const saved = b.api_key ? null : await aiSettings.active();
    const apiKey = b.api_key ?? (saved?.provider === b.provider ? saved.apiKey : null);
    if (!apiKey) throw new ApiError(422, 'validation', 'Paste the API key to test it', { api_key: 'Required' });
    const model = b.model ?? AI_PROVIDERS[b.provider].defaultModel;
    try {
      const reply = await callProvider(fetchImpl, b.provider, model, apiKey, {
        system: 'You are a connection test. Reply with JSON only.',
        user: 'Return exactly {"ok": true}.',
      }, Math.min(config.AI_REQUEST_TIMEOUT_MS, 30000));
      return c.json({ ok: true, provider: b.provider, model, latency_ms: reply.latencyMs });
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, 'provider_error', err.message);
      throw err;
    }
  });

  // ---- Reset (local mode) ------------------------------------------------------
  // Local mode only: start over with no shifts, reports or tickets (accounts and setup stay).
  r.post('/activity/reset', async (c) => {
    const { config } = svc(c);
    if (config.APP_MODE !== 'local' || !config.DEMO_MODE) throw new ApiError(404, 'not_found', 'Not found');
    await parseBody(c, z.strictObject({ confirm: z.literal('CLEAR') }));
    return c.json({ cleared: await resetActivity(svc(c), c.get('userId')) });
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
          ...(await analysis.status()),
          webhook_configured: Boolean(config.N8N_ANALYSIS_WEBHOOK_URL),
          prompt_version: config.PROMPT_VERSION,
        },
        email: { transport: notifications.transportName, simulated: notifications.transportName === 'dev', from: config.EMAIL_FROM },
        sms: {
          connected: notifications.smsTransportName !== 'none',
          transport: notifications.smsTransportName,
          webhook_configured: Boolean(config.N8N_SMS_WEBHOOK_URL),
          from: config.SMS_FROM,
          note:
            notifications.smsTransportName === 'none'
              ? 'Optional SMS is off. In-app and email notifications continue normally.'
              : 'SMS is handed to a dedicated authenticated n8n workflow.',
        },
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

  r.post('/tick', async (c) => {
    const result = await svc(c).db.asService(async (q) => (await q.query<{ r: unknown }>('select internal.scheduled_tick() as r'))[0]!.r);
    svc(c).kick();
    return c.json(result);
  });

  return r;
}
