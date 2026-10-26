import { createApp } from '../src/app';
import { createServices } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, SECOND_DEPARTMENT_ACCOUNTS, seedDemo } from '../src/seed/demo';

// Tests also seed a second department to prove departments cannot see each other.
const ACCOUNTS = [...DEMO_ACCOUNTS, ...SECOND_DEPARTMENT_ACCOUNTS];

export const CALLBACK_SECRET = 'test-callback-secret-0123456789abcdef';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';

export type FetchCall = { url: string; init: RequestInit; body: any };

export async function setup(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_MODE: 'local',
    DEMO_MODE: 'true',
    DEV_ANALYSIS_DELAY_MS: '0',
    ENABLE_INTERNAL_SCHEDULER: 'false',
    N8N_CALLBACK_SECRET: CALLBACK_SECRET,
    ...env,
  });
  const services = await createServices(config, { memory: true, quiet: true, manualKick: true, fetchImpl });
  await seedDemo(services, { onlyIfEmpty: false, includeSecondDepartment: true });
  const app = createApp(services);
  const ids: Record<string, string> = {};
  for (const row of await services.db.asService((q) => q.query<{ id: string; email: string }>('select id, email from public.profiles'))) {
    const account = ACCOUNTS.find((a) => a.email === row.email);
    if (account) ids[account.key] = row.id;
  }

  const tokens: Record<string, string> = {};
  /** Signs in an account created during a test and makes it callable by key. */
  async function loginAs(key: string, email: string, password: string) {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status}`);
    tokens[key] = ((await res.json()) as { token: string }).token;
  }

  async function token(key: string) {
    if (tokens[key]) return tokens[key]!;
    const email = ACCOUNTS.find((a) => a.key === key)!.email;
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: DEMO_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login failed for ${key}: ${res.status}`);
    tokens[key] = ((await res.json()) as { token: string }).token;
    return tokens[key]!;
  }

  async function call(who: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (who) h.Authorization = `Bearer ${await token(who)}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  /** Runs one pass of queued automation work, as the background loop would. */
  async function drain() {
    for (let i = 0; i < 5; i++) {
      const a = await services.analysis.runDue();
      const n = await services.notifications.runDue();
      if (!a && !n) break;
    }
  }

  const sql = <T = any>(text: string, params?: unknown[]) => services.db.asService((q) => q.query<T>(text, params));
  const sqlAs = <T = any>(key: string, text: string, params?: unknown[]) => services.db.asUser(ids[key]!, (q) => q.query<T>(text, params));

  return { services, app, ids, token, loginAs, call, drain, sql, sqlAs, close: () => services.stop() };
}

export type Harness = Awaited<ReturnType<typeof setup>>;

export async function demoOutgoingShift(h: Harness): Promise<string> {
  const [row] = await h.sql<{ id: string }>(
    `select s.id from public.shifts s join public.shift_assignments a on a.shift_id = s.id
      where s.label = 'Demo shift — Outgoing' and s.status = 'scheduled' and a.employee_id = $1 order by s.created_at desc limit 1`,
    [h.ids.juan],
  );
  return row!.id;
}

/** Creates a shift as the warehouse supervisor (who owns the schedule) and assigns a worker to it. */
export async function adhocShift(h: Harness, opts: { startsSql: string; endsSql: string; employee: string; label?: string; grace?: number }) {
  return h.services.db.asUser(h.ids.manager!, async (q) => {
    const [s] = await q.query<{ id: string }>(
      `select app.create_shift(null, $1, ${opts.startsSql}, ${opts.endsSql}, 30, $2, null, true) as id`,
      [opts.label ?? 'Ad hoc', opts.grace ?? 30],
    );
    await q.query('select app.assign_to_shift($1, $2)', [s!.id, h.ids[opts.employee]]);
    return s!.id;
  });
}

export const flagResolutionsFor = (flags: unknown[]) =>
  flags.map((_f, i) => ({ flag_index: i, resolution: 'accepted_as_unverified', note: 'Checked during review' }));
