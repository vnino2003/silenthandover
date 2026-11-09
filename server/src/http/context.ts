import type { Context } from 'hono';
import type { z } from 'zod';
import type { Role } from '@sh/shared';
import type { AuthProvider } from '../auth/auth';
import type { AnalysisPipeline } from '../automation/analysis';
import type { AiSettings } from '../automation/ai-provider';
import type { EmailSender } from '../automation/email-sender';
import type { NotificationDispatcher } from '../automation/notifications';
import type { Config } from '../config';
import type { Db, Queryable } from '../db/types';
import { ApiError, fromZodError } from './errors';

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: Role;
  department_id: string | null;
  department_name: string | null;
  department_timezone: string | null;
  team_id: string | null;
  team_name: string | null;
  pseudonym: string;
  notify_email: boolean;
  notify_sms: boolean;
  is_active: boolean;
  server_now: string;
}

export interface Services {
  config: Config;
  db: Db;
  auth: AuthProvider;
  analysis: AnalysisPipeline;
  /** The AI provider and encrypted key the administrator saved. */
  aiSettings: AiSettings;
  /** The email sender the administrator connected (or the configured fallback). */
  email: EmailSender;
  notifications: NotificationDispatcher;
  /** Outbound HTTP (replaced in tests). */
  fetchImpl: typeof fetch;
  /** Process queued automation work soon (non-blocking). */
  kick: () => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export type AppEnv = {
  Variables: {
    services: Services;
    requestId: string;
    userId: string;
    profile: Profile;
  };
};

export type Ctx = Context<AppEnv>;

export const svc = (c: Ctx) => c.get('services');

/** Runs queries as the signed-in user: RLS and auth.uid() apply. */
export const asUser = <T>(c: Ctx, fn: (q: Queryable) => Promise<T>) => svc(c).db.asUser(c.get('userId'), fn);

export function requireRole(c: Ctx, ...roles: Role[]) {
  if (!roles.includes(c.get('profile').role)) {
    throw new ApiError(403, 'forbidden', 'You do not have access to this area');
  }
}

export async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'bad_request', 'Request body must be JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

export function parseQuery<S extends z.ZodType>(c: Ctx, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function idParam(c: Ctx, name = 'id'): string {
  const v = c.req.param(name);
  if (!v || !UUID_RE.test(v)) throw new ApiError(404, 'not_found', 'Not found');
  return v;
}

export async function one<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T> {
  const rows = await q.query<T>(sql, params);
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Not found');
  return rows[0];
}

export async function scalar<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T> {
  const rows = await q.query<{ v: T }>(sql, params);
  return rows[0]!.v;
}
