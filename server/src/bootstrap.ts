import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalAuth, createSupabaseAuth } from './auth/auth';
import { AnalysisPipeline, createDevAnalysisAdapter, createN8nAnalysisAdapter } from './automation/analysis';
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

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCAL_DIR = resolve(here, '../.data');

export const log = (msg: string, extra?: Record<string, unknown>) => {
  // Structured, content-free logging: never pass report text here.
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
};

function localSecret(dir: string): string {
  const file = join(dir, 'local-jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(48).toString('base64url');
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
  }

  const auth =
    config.APP_MODE === 'local'
      ? createLocalAuth(db, config.LOCAL_JWT_SECRET ?? (opts.memory ? randomBytes(48).toString('base64url') : localSecret(localDir)))
      : createSupabaseAuth(config);

  const adapter =
    config.AI_ADAPTER === 'n8n' ? createN8nAnalysisAdapter(config, fetchImpl) : createDevAnalysisAdapter(config.DEV_ANALYSIS_DELAY_MS, logger);
  const analysis = new AnalysisPipeline(db, config, adapter, logger);

  const transport: EmailTransport =
    config.EMAIL_TRANSPORT === 'resend'
      ? createResendTransport(config, fetchImpl)
      : config.EMAIL_TRANSPORT === 'n8n'
        ? createN8nTransport(config, fetchImpl)
        : createDevTransport();
  const smsTransport = config.SMS_TRANSPORT === 'n8n' ? createN8nSmsTransport(config, fetchImpl) : null;
  const notifications = new NotificationDispatcher(db, config, transport, smsTransport, logger);

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
        if (ticks % 2 === 0) await db.asService((q) => q.query('select internal.scheduled_tick()'));
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
