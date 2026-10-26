import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createServices, log } from './bootstrap';
import { loadConfig } from './config';
import { seedDemo } from './seed/demo';

// Reads server/.env when present (Node 20.12+). Real environment variables take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const services = await createServices(config);

if (config.APP_MODE === 'local' && config.DEMO_MODE) {
  const seeded = await seedDemo(services, { onlyIfEmpty: true });
  if (seeded) log('demo data seeded', { accounts: seeded.accounts.length });
}

const app = createApp(services);
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log('api listening', {
    port: info.port,
    mode: config.APP_MODE,
    ai: config.AI_ADAPTER === 'dev' ? 'dev simulator (no AI calls)' : 'n8n',
    email: config.EMAIL_TRANSPORT === 'dev' ? 'dev outbox (nothing sent)' : config.EMAIL_TRANSPORT,
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
