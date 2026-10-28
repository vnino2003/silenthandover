import { Hono } from 'hono';
import { DepartmentExperience } from '@sh/shared';
import { z } from 'zod';
import { DEFAULT_ORGANIZATION_RULES, ReportDraftContent, ROLES, type PromptVersion } from '@sh/shared';
import { maskAddress } from '../automation/notifications';
import { ApiError } from '../http/errors';
import { asUser, idParam, parseBody, parseQuery, requireRole, svc, type AppEnv, type Ctx } from '../http/context';
import { checkRules, currentRules } from '../automation/ai-rules';
import { resetActivity } from '../seed/demo';
import { AI_PROVIDERS, callWithFallback, listModels, pickModel, ProviderError } from '../automation/ai-provider';
import { describeStoredRun, previewPipeline, type StoredRun } from '../automation/preview';

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
    const apiKey = b.api_key ?? (await aiSettings.savedKey(b.provider));
    if (!apiKey) throw new ApiError(422, 'validation', 'Paste the API key to test it', { api_key: 'Required' });
    try {
      // No model chosen: test exactly what reports would use — the newest model, moving on to the
      // next one if it is busy.
      const reply = await callWithFallback(aiSettings, fetchImpl, { provider: b.provider, apiKey, model: b.model ?? null }, {
        system: 'You are a connection test. Reply with JSON only.',
        user: 'Return exactly {"ok": true}.',
      }, Math.min(config.AI_REQUEST_TIMEOUT_MS, 20000), 50000);
      return c.json({ ok: true, provider: b.provider, model: reply.model, automatic: !b.model, busy_skipped: reply.tried.slice(0, -1), latency_ms: reply.latencyMs });
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, 'provider_error', err.message);
      throw err;
    }
  });

  // The models this key can actually use, newest first, and the one "automatic" would pick.
  r.post('/ai/models', async (c) => {
    const b = await parseBody(c, z.strictObject({ provider: z.enum(['gemini', 'grok']), api_key: z.string().trim().min(16).max(300).optional() }));
    const { aiSettings, fetchImpl } = svc(c);
    const apiKey = b.api_key ?? (await aiSettings.savedKey(b.provider));
    if (!apiKey) throw new ApiError(422, 'validation', 'Paste the API key first', { api_key: 'Required' });
    try {
      const models = await listModels(fetchImpl, b.provider, apiKey);
      return c.json({ models, suggested: pickModel(b.provider, models) });
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, 'provider_error', err.message);
      throw err;
    }
  });

  // ---- Real AI runs, censored ------------------------------------------------------
  // What really went to the AI for recent reports. Only the censored text and the answer with
  // names still as codes; never the original report or the code-to-name list.
  r.get('/ai/runs', async (c) => {
    const rows = await svc(c).db.asService((q) =>
      q.query(
        `select r.id, sr.reference_code, d.name as department_name, s.label as shift_label, r.revision_no, r.attempt,
                r.status, r.engine, r.model, r.is_simulated, r.created_at,
                coalesce(jsonb_array_length(r.flags), 0) as flag_count
           from public.ai_analysis_runs r
           join public.shift_reports sr on sr.id = r.report_id
           join public.shifts s on s.id = sr.shift_id
           join public.departments d on d.id = sr.department_id
          order by r.created_at desc limit 30`,
      ),
    );
    return c.json(rows);
  });

  r.get('/ai/runs/:id', async (c) => {
    const id = idParam(c);
    const { db } = svc(c);
    const [run] = await db.asService((q) =>
      q.query<StoredRun & { department_name: string; created_at: Date; revision_no: number; attempt: number }>(
        `select sr.reference_code, s.label || ' ' || s.shift_date::text as shift_label, r.prompt_version, a.sanitized_text, a.redaction_counts,
                a.injection_findings, r.engine, r.model, r.is_simulated, r.latency_ms, r.status, r.draft, r.flags, r.validation_errors,
                d.name as department_name, r.created_at, r.revision_no, r.attempt,
                (select to_jsonb(v) - 'is_default' - 'created_by' - 'created_at' from public.ai_rule_versions v where v.version = r.org_rules_version) as org_rules
           from public.ai_analysis_runs r
           join public.shift_reports sr on sr.id = r.report_id
           join public.shifts s on s.id = sr.shift_id
           join public.departments d on d.id = sr.department_id
           left join internal.analysis_inputs a on a.report_id = r.report_id and a.revision_no = r.revision_no
          where r.id = $1`,
        [id],
      ),
    );
    if (!run) throw new ApiError(404, 'not_found', 'Run not found');
    await db.asService((q) =>
      q.query(`insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details) values ($1, 'admin', 'ai.run_viewed', 'ai_analysis_run', $2, '{}'::jsonb)`, [
        c.get('userId'),
        id,
      ]),
    );
    return c.json({
      run: { reference_code: run.reference_code, department_name: run.department_name, shift_label: run.shift_label, created_at: run.created_at, revision_no: run.revision_no, attempt: run.attempt },
      ...describeStoredRun(run),
    });
  });

  // ---- AI pipeline preview ---------------------------------------------------------
  // Runs an example report through every real step and shows what each one produced. The
  // administrator never sees real reports here: only the example they type. Nothing is stored.
  r.post('/ai/preview', async (c) => {
    const b = await parseBody(
      c,
      z.strictObject({ content: ReportDraftContent, engine: z.enum(['simulator', 'provider']).default('simulator') }),
    );
    const { aiSettings, config, fetchImpl, db } = svc(c);
    const roster = await db.asService((q) =>
      q.query<{ full_name: string; pseudonym: string }>('select full_name, pseudonym from public.profiles where is_active'),
    );
    try {
      const result = await previewPipeline({
        content: b.content,
        roster,
        promptVersion: config.PROMPT_VERSION as PromptVersion,
        orgRules: await currentRules(db),
        engine: b.engine,
        aiSettings,
        fetchImpl,
        timeoutMs: Math.min(config.AI_REQUEST_TIMEOUT_MS, 60000),
      });
      await db.asService((q) =>
        q.query(`insert into public.audit_logs (actor_id, actor_role, action, entity_type, details) values ($1, 'admin', 'ai.preview_run', 'system', $2::jsonb)`, [
          c.get('userId'),
          JSON.stringify({ engine: result.ai.engine, model: result.ai.model }),
        ]),
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'no_provider') throw new ApiError(409, 'no_provider', 'No AI provider is connected yet — run it with the simulator, or connect one first');
      if (err instanceof ProviderError) throw new ApiError(502, 'provider_error', err.message);
      throw err;
    }
  });

  // ---- Organization rules ----------------------------------------------------------
  // Added on top of the locked default prompt rules, for report cleaning and Mica. Each save is a
  // new version (audited); the newest applies to every new AI request.
  const rulesView = async (c: Ctx) => {
    const { db } = svc(c);
    const history = await db.asService((q) =>
      q.query(
        `select v.version, v.is_default, v.created_at, p.full_name as created_by_name,
                cardinality(v.policy_rules) as policy_count, cardinality(v.negative_constraints) as never_count
           from public.ai_rule_versions v left join public.profiles p on p.id = v.created_by
          order by v.version desc limit 10`,
      ),
    );
    return { current: await currentRules(db), defaults: DEFAULT_ORGANIZATION_RULES, history };
  };
  const saveRules = async (c: Ctx, rules: { policy_rules: string[]; negative_constraints: string[] }) => {
    await asUser(c, (q) => q.query('select app.admin_save_ai_rules($1::text[], $2::text[])', [rules.policy_rules, rules.negative_constraints]));
    return rulesView(c);
  };
  r.get('/ai/rules', async (c) => c.json(await rulesView(c)));
  r.put('/ai/rules', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'bad_request', 'Request body must be JSON');
    }
    return c.json(await saveRules(c, checkRules(raw)));
  });
  r.post('/ai/rules/reset', async (c) =>
    c.json(await saveRules(c, { policy_rules: DEFAULT_ORGANIZATION_RULES.policy_rules, negative_constraints: DEFAULT_ORGANIZATION_RULES.negative_constraints })),
  );

  // ---- Reset (local mode) ------------------------------------------------------
  // Local mode only: start over with no shifts, reports or tickets (accounts and setup stay).
  r.post('/activity/reset', async (c) => {
    const { config } = svc(c);
    if (config.APP_MODE !== 'local' || !config.DEMO_MODE) throw new ApiError(404, 'not_found', 'Not found');
    await parseBody(c, z.strictObject({ confirm: z.literal('CLEAR') }));
    return c.json({ cleared: await resetActivity(svc(c), c.get('userId')) });
  });

  // ---- Users ---------------------------------------------------------------
  r.get('/users', async (c) =>
    c.json(
      await asUser(c, async (q) => {
        const users = ((await q.query<{ u: { id: string }[] | null }>('select app.admin_list_users() as u'))[0]!.u ?? []);
        // Job titles (shown on schedules) live beside the existing profile fields.
        const titles = new Map((await q.query<{ id: string; job_title: string | null }>('select id, job_title from public.profiles')).map((p) => [p.id, p.job_title]));
        return users.map((u) => ({ ...u, job_title: titles.get(u.id) ?? null }));
      }),
    ),
  );

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
        `select d.id, d.code, d.name, d.timezone, d.created_at, d.experience,
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

  r.put('/departments/:id/experience', async (c) => {
    const id = idParam(c);
    const value = await parseBody(c, DepartmentExperience);
    await asUser(c, (q) => q.query('select app.set_department_experience($1,$2::jsonb)', [id, JSON.stringify(value)]));
    return c.json(value);
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
                e.last_error, e.created_at, e.idempotency_key, d.name as department_name,
                -- A failed analysis that a later run of the same revision completed needs no action.
                (e.kind = 'report_analysis' and e.status in ('failed', 'dead') and exists (
                  select 1 from public.automation_events x where x.kind = 'report_analysis' and x.status = 'completed'
                     and x.report_id = e.report_id and x.revision_no = e.revision_no and x.created_at > e.created_at)) as superseded
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
    const result = await svc(c).db.asService(async (q) => {
      const tick = (await q.query<{ r: Record<string, unknown> }>('select internal.scheduled_tick() as r'))[0]!.r;
      const schedule = (await q.query<{ r: Record<string, unknown> }>('select internal.schedule_tick() as r'))[0]!.r;
      return { ...tick, ...schedule };
    });
    svc(c).kick();
    return c.json(result);
  });

  return r;
}
