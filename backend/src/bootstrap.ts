import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalAuth, createSupabaseAuth } from './auth/auth';
import { AiSettings } from './automation/ai-provider';
import { createGmailTransport, EmailSender, type SmtpFactory } from './automation/email-sender';
import { AnalysisPipeline, createAdminAnalysisAdapter, createDevAnalysisAdapter, createN8nAnalysisAdapter } from './automation/analysis';
import {
  createDevTransport,
  createN8nTransport,
  createN8nSmsTransport,
  createResendTransport,
  NotificationDispatcher,
  type EmailTransport,
} from './automation/notifications';
import type { Config } from './config';
import { migrate } from './db/migrate';
import { createPgliteDb } from './db/pglite';
import { createPostgresDb } from './db/postgres';
import type { Db } from './db/types';
import type { Services } from './http/context';
import { createSecretBox, decodeSecretsKey } from './security/secrets';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCAL_DIR = resolve(here, '../.data');

export const log = (msg: string, extra?: Record<string, unknown>) => {
  // Structured, content-free logging: never pass report text here.
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
};

function localSecret(dir: string, name = 'local-jwt-secret', bytes = 48): string {
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(bytes).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export interface BootstrapOptions {
  /** In-memory database (tests). */
  memory?: boolean;
  fetchImpl?: typeof fetch;
  quiet?: boolean;
  /** Tests drive background work explicitly instead of on kick(). */
  manualKick?: boolean;
  /** Replaces the SMTP connection (tests). */
  smtp?: SmtpFactory;
}

export async function createServices(config: Config, opts: BootstrapOptions = {}): Promise<Services & { stop: () => Promise<void> }> {
  const logger = opts.quiet ? () => {} : log;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const localDir = config.LOCAL_DB_DIR ? resolve(config.LOCAL_DB_DIR) : DEFAULT_LOCAL_DIR;

  let db: Db;
  if (config.APP_MODE === 'local') {
    db = await createPgliteDb(opts.memory ? null : join(localDir, 'local-db.tar.gz'));
    const ran = await migrate(db, { localShim: true, log: (m) => logger('migration', { m }) });
    if (ran.length) logger('local database migrated', { count: ran.length });
  } else {
    db = createPostgresDb(config.DATABASE_URL!);
    // A new Supabase project gets its tables on the first start; later starts apply only new files.
    if (config.MIGRATE_ON_START && !opts.memory) {
      const ran = await migrate(db, { localShim: false, log: (m) => logger('migration', { m }) });
      if (ran.length) logger('database migrated', { count: ran.length });
    }
  }

  const auth =
    config.APP_MODE === 'local'
      ? createLocalAuth(db, config.LOCAL_JWT_SECRET ?? (opts.memory ? randomBytes(48).toString('base64url') : localSecret(localDir)))
      : createSupabaseAuth(config);

  // Secrets entered in the app are encrypted with this key. Without one (Supabase mode with no
  // SECRETS_ENCRYPTION_KEY) the admin page cannot store an AI key and the simulator keeps running.
  const secretsKey = config.SECRETS_ENCRYPTION_KEY
    ? decodeSecretsKey(config.SECRETS_ENCRYPTION_KEY)
    : config.APP_MODE === 'local'
      ? opts.memory
        ? randomBytes(32)
        : decodeSecretsKey(localSecret(localDir, 'local-secrets-key', 32))
      : null;
  const secretBox = secretsKey ? createSecretBox(secretsKey) : null;
  const aiSettings = new AiSettings(db, secretBox, fetchImpl);
  const adapter =
    config.AI_ADAPTER === 'n8n'
      ? createN8nAnalysisAdapter(config, fetchImpl)
      : config.AI_ADAPTER === 'dev'
        ? createDevAnalysisAdapter(config.DEV_ANALYSIS_DELAY_MS, logger)
        : createAdminAnalysisAdapter(aiSettings, { fetchImpl, timeoutMs: config.AI_REQUEST_TIMEOUT_MS, devDelayMs: config.DEV_ANALYSIS_DELAY_MS, log: logger });
  const analysis = new AnalysisPipeline(db, config, adapter, logger);

  const transport: EmailTransport =
    config.EMAIL_TRANSPORT === 'resend'
      ? createResendTransport(config, fetchImpl)
      : config.EMAIL_TRANSPORT === 'n8n'
        ? createN8nTransport(config, fetchImpl)
        : config.EMAIL_TRANSPORT === 'gmail'
          ? createGmailTransport(
              { fromName: config.EMAIL_FROM.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? 'Silent Handover', fromAddress: config.GMAIL_USER!, secret: config.GMAIL_APP_PASSWORD! },
              opts.smtp,
            )
          : createDevTransport();
  const smsTransport = config.SMS_TRANSPORT === 'n8n' ? createN8nSmsTransport(config, fetchImpl) : null;
  // The sender the administrator saves on the Integrations page (Gmail or Resend) takes over
  // from the configured transport without a restart.
  const email = new EmailSender(db, secretBox, transport, fetchImpl, opts.smtp);
  await email.load();
  const notifications = new NotificationDispatcher(db, config, email.transport(), smsTransport, logger);

  // Background work runs one pass at a time; a kick during a pass schedules one more pass.
  let running = false;
  let again = false;
  let stopped = false;
  const pass = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await analysis.runDue();
        await notifications.runDue();
      } while (again && !stopped);
    } catch (err) {
      logger('background pass failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const kick = () => {
    if (opts.manualKick) return;
    setTimeout(() => void pass(), 0);
  };

  let timer: NodeJS.Timeout | null = null;
  if (config.ENABLE_INTERNAL_SCHEDULER && !opts.memory) {
    let ticks = 0;
    timer = setInterval(async () => {
      ticks += 1;
      try {
        // The scheduled tick (timeouts, escalations, missing reports) runs every other interval.
        if (ticks % 2 === 0) {
          await db.asService((q) => q.query('select internal.scheduled_tick()'));
          // Shift reminders and staffing alerts.
          await db.asService((q) => q.query('select internal.schedule_tick()'));
        }
      } catch (err) {
        logger('scheduled tick failed', { error: err instanceof Error ? err.message : String(err) });
      }
      await pass();
    }, config.SCHEDULER_INTERVAL_MS);
  }

  return {
    config,
    db,
    auth,
    analysis,
    aiSettings,
    email,
    fetchImpl,
    notifications,
    kick,
    log: logger,
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20));
      await db.close();
    },
  };
}
