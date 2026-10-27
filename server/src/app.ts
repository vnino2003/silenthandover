import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, fromDbError } from './http/errors';
import { clientIp, rateLimit } from './http/rate-limit';
import { svc, type AppEnv, type Profile, type Services } from './http/context';
import { adminRoutes } from './routes/admin';
import { employeeRoutes } from './routes/employee';
import { leaveRoutes } from './routes/leave';
import { integrationRoutes } from './routes/integrations';
import { issueRoutes } from './routes/issues';
import { managerRoutes } from './routes/manager';
import { meRoutes } from './routes/me';
import { assistantRoutes } from './routes/assistant';
import { assistantHelpRoutes } from './routes/assistant-help';

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('services', services);
    c.set('requestId', randomUUID());
    await next();
  });
  app.use('*', secureHeaders());
  app.use('/api/*', cors({ origin: services.config.corsOrigins, allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    const apiErr = err instanceof ApiError ? err : fromDbError(err);
    if (apiErr) {
      return c.json({ error: { code: apiErr.code, message: apiErr.message, fields: apiErr.fields, request_id: requestId } }, apiErr.status as 400);
    }
    // Log the type and code only — never request bodies, which may contain report content.
    const e = err as { code?: string; name?: string; message?: string };
    services.log('unhandled error', { requestId, name: e?.name, code: e?.code, message: e?.message?.slice(0, 200), path: c.req.path });
    return c.json({ error: { code: 'internal', message: 'Something went wrong. Please try again.', request_id: requestId } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.get('/api/health', async (c) => {
    await svc(c).db.asService((q) => q.query('select 1'));
    return c.json({ ok: true });
  });

  // Public configuration: what the browser needs to sign in, and truthful integration status.
  app.get('/api/config', async (c) => {
    const { config, auth, analysis, notifications } = svc(c);
    const ai = await analysis.status();
    return c.json({
      mode: config.APP_MODE,
      auth:
        auth.mode === 'supabase'
          ? { provider: 'supabase', supabase_url: config.SUPABASE_URL, supabase_anon_key: config.SUPABASE_ANON_KEY }
          : { provider: 'local' },
      // Local demo tools (demo shifts, clearing demo data). Never enabled in Supabase mode.
      // Account details are not sent: the sign-in page shows no account list.
      demo: config.APP_MODE === 'local' && config.DEMO_MODE ? { enabled: true } : null,
      integrations: {
        ai: { adapter: ai.adapter, provider: ai.provider, model: ai.model, simulated: ai.simulated, prompt_version: config.PROMPT_VERSION },
        email: { transport: notifications.transportName, simulated: notifications.transportName === 'dev' },
        sms: { connected: notifications.smsTransportName !== 'none', transport: notifications.smsTransportName },
      },
    });
  });

  const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `login:${clientIp(c)}` });
  app.post('/api/auth/login', loginLimiter, async (c) => {
    const { auth } = svc(c);
    if (!auth.login) throw new ApiError(404, 'not_found', 'Sign in through Supabase Auth');
    const body = z.object({ email: z.email(), password: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    return c.json(await auth.login(body.data.email, body.data.password));
  });

  // n8n callbacks authenticate with their own shared secret, not a user session.
  app.route('/api/integrations/n8n', integrationRoutes());

  // Everything below requires a signed-in, active user.
  const authed = new Hono<AppEnv>();
  authed.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new ApiError(401, 'unauthenticated', 'Please sign in');
    const userId = await svc(c).auth.verify(token);
    const profile = await svc(c).db.asUser(userId, async (q) => {
      const rows = await q.query<{ p: Profile | null }>('select app.my_profile() as p');
      return rows[0]?.p ?? null;
    });
    if (!profile) throw new ApiError(403, 'no_profile', 'Your account has not been set up yet. Contact an administrator.');
    if (!profile.is_active) throw new ApiError(403, 'inactive', 'Your account is deactivated');
    c.set('userId', userId);
    c.set('profile', profile);
    await next();
  });
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 120, key: (cc) => `w:${cc.get('userId')}` });
  authed.use('*', (c, next) => (c.req.method === 'GET' ? next() : writeLimiter(c, next)));
  authed.route('/', meRoutes());
  authed.route('/', employeeRoutes());
  authed.route('/', leaveRoutes());
  authed.route('/', assistantHelpRoutes());
  authed.route('/', assistantRoutes());
  authed.route('/', issueRoutes());
  authed.route('/manager', managerRoutes());
  authed.route('/admin', adminRoutes());
  app.route('/api', authed);

  return app;
}
