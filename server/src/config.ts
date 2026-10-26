import { z } from 'zod';
import { PROMPT_VERSIONS } from '@sh/shared';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8787),
  APP_BASE_URL: z.url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.url().default('http://localhost:8787'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // 'local' = embedded PostgreSQL + local test auth. 'supabase' = Supabase Postgres + Supabase Auth.
  APP_MODE: z.enum(['local', 'supabase']).default('local'),
  LOCAL_DB_DIR: z.string().optional(),
  LOCAL_JWT_SECRET: z.string().min(32).optional(),
  DEMO_MODE: bool.default(true),

  DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),

  // AI processing: 'dev' = clearly labeled local simulator, 'n8n' = real workflow.
  AI_ADAPTER: z.enum(['dev', 'n8n']).default('dev'),
  PROMPT_VERSION: z.enum(PROMPT_VERSIONS).default('1.0'),
  DEV_ANALYSIS_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  N8N_ANALYSIS_WEBHOOK_URL: z.url().optional(),
  N8N_DELIVERY_WEBHOOK_URL: z.url().optional(),
  N8N_WEBHOOK_SECRET: z.string().min(24).optional(),
  N8N_CALLBACK_SECRET: z.string().min(24).optional(),
  N8N_REQUEST_TIMEOUT_MS: z.coerce.number().int().default(10000),

  // Email: 'dev' records messages in the dev outbox as "simulated" — nothing is sent.
  EMAIL_TRANSPORT: z.enum(['dev', 'resend', 'n8n']).default('dev'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Silent Handover <handover@example.com>'),

  ENABLE_INTERNAL_SCHEDULER: bool.default(true),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
});

export type Config = z.infer<typeof EnvSchema> & { corsOrigins: string[] };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const problems: string[] = [];
  if (c.APP_MODE === 'supabase') {
    if (!c.DATABASE_URL) problems.push('DATABASE_URL is required when APP_MODE=supabase');
    if (!c.SUPABASE_URL) problems.push('SUPABASE_URL is required when APP_MODE=supabase');
    if (!c.SUPABASE_ANON_KEY) problems.push('SUPABASE_ANON_KEY is required when APP_MODE=supabase');
    if (!c.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is required to manage users');
  }
  if (c.AI_ADAPTER === 'n8n' && (!c.N8N_ANALYSIS_WEBHOOK_URL || !c.N8N_WEBHOOK_SECRET || !c.N8N_CALLBACK_SECRET)) {
    problems.push('AI_ADAPTER=n8n needs N8N_ANALYSIS_WEBHOOK_URL, N8N_WEBHOOK_SECRET and N8N_CALLBACK_SECRET');
  }
  if (c.EMAIL_TRANSPORT === 'resend' && !c.RESEND_API_KEY) problems.push('EMAIL_TRANSPORT=resend needs RESEND_API_KEY');
  if (c.EMAIL_TRANSPORT === 'n8n' && (!c.N8N_DELIVERY_WEBHOOK_URL || !c.N8N_WEBHOOK_SECRET || !c.N8N_CALLBACK_SECRET)) {
    problems.push('EMAIL_TRANSPORT=n8n needs N8N_DELIVERY_WEBHOOK_URL, N8N_WEBHOOK_SECRET and N8N_CALLBACK_SECRET');
  }
  if (c.NODE_ENV === 'production') {
    if (c.APP_MODE === 'local') problems.push('APP_MODE=local is for development only');
    if (c.N8N_ANALYSIS_WEBHOOK_URL && !c.N8N_ANALYSIS_WEBHOOK_URL.startsWith('https://')) {
      problems.push('N8N_ANALYSIS_WEBHOOK_URL must use HTTPS in production');
    }
    if (c.N8N_DELIVERY_WEBHOOK_URL && !c.N8N_DELIVERY_WEBHOOK_URL.startsWith('https://')) {
      problems.push('N8N_DELIVERY_WEBHOOK_URL must use HTTPS in production');
    }
  }
  if (problems.length) throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  return { ...c, corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) };
}
