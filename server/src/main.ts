import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createServices, log } from './bootstrap';
import { loadConfig } from './config';
import { seedDemo } from './seed/demo';
import { ensureFirstAdmin } from './auth/first-admin';

// Reads server/.env when present (Node 20.12+). Real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const services = await createServices(config);

if (config.APP_MODE === 'local' && config.DEMO_MODE) {
  const seeded = await seedDemo(services, { onlyIfEmpty: true, sampleActivity: true, presentation: true });
  if (seeded) log('demo data seeded', { accounts: seeded.accounts.length });
}

// A real organization: FIRST_ADMIN_EMAIL is invited as the only administrator.
await ensureFirstAdmin(services, log);

const app = createApp(services);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log('api listening', {
    port: info.port,
    mode: config.APP_MODE,
    ai: config.AI_ADAPTER === 'dev' ? 'dev simulator (no AI calls)' : config.AI_ADAPTER === 'n8n' ? 'n8n' : 'set by the administrator (simulator until a key is saved)',
    email: services.email.delivers ? services.email.name : 'not connected (Integrations -> Email)',
  });
  services.kick();
});

const shutdown = async () => {
  server.close();
  await services.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
