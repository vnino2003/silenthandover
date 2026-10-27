// npm run seed            — seed demo data if the database is empty
// npm run seed -- --reset — LOCAL MODE ONLY: delete the local database and seed again
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServices, DEFAULT_LOCAL_DIR, log } from '../bootstrap';
import { loadConfig } from '../config';
import { ROLE_LABELS, type Role } from '@sh/shared';
import { DEMO_PASSWORD, seedDemo } from '../seed/demo';

// Reads server/.env when present (Node 20.12+). Real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig({ ...process.env, ENABLE_INTERNAL_SCHEDULER: 'false' });
if (process.argv.includes('--reset')) {
  if (config.APP_MODE !== 'local') throw new Error('--reset is only available in local mode');
  const dir = config.LOCAL_DB_DIR ? resolve(config.LOCAL_DB_DIR) : DEFAULT_LOCAL_DIR;
  rmSync(join(dir, 'local-db.tar.gz'), { force: true });
  log('local database removed', { dir });
}
const services = await createServices(config);
const result = await seedDemo(services, { onlyIfEmpty: true, sampleActivity: true, presentation: true });
if (result) {
  console.log('\nSynthetic demo accounts (local test passwords — do not reuse):');
  for (const a of result.accounts) console.log(`  ${ROLE_LABELS[a.role as Role].padEnd(11)} ${a.email.padEnd(28)} ${a.full_name}`);
  console.log(`  password: ${DEMO_PASSWORD}\n`);
} else {
  log('database already has users; nothing seeded (use --reset in local mode)');
}
await services.stop();
