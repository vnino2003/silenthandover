// Applies supabase/migrations to DATABASE_URL (or the local embedded database).
// With the Supabase CLI you can instead run `supabase db push`.
import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { createServices, log } from '../bootstrap';
import { migrate } from '../db/migrate';

// Reads backend/.env when present (Node 20.12+). Real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig({ ...process.env, ENABLE_INTERNAL_SCHEDULER: 'false' });
const services = await createServices(config);
if (config.APP_MODE === 'supabase') {
  const ran = await migrate(services.db, { localShim: false, log: (m) => log('migration', { m }) });
  log('migrations complete', { applied: ran.length });
} else {
  log('local database is migrated automatically on start');
}
await services.stop();
