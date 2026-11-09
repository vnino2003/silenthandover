// npm run setup:live -- --admin you@gmail.com [--name "Your Name"] [--replace] — LOCAL ONLY.
// Starts the real organization in a new, empty database next to the current one:
//   - no demo people, departments, shifts, reports or tickets;
//   - one administrator (--admin), who gets an email invitation to choose a password and then
//     adds the departments and everyone else;
//   - keeps the configuration the administrator already set up: the connected email sender and
//     AI provider (still encrypted, with the same key), the organization's AI rules, settings
//     and email templates.
// The current database is not touched; backend/.env is switched to the new one. Stop the app first.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServices, DEFAULT_LOCAL_DIR } from '../bootstrap';
import { loadConfig } from '../config';
import { ensureFirstAdmin } from '../auth/first-admin';

if (existsSync('.env')) process.loadEnvFile('.env');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const adminEmail = arg('admin');
if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
  console.error('Usage: npm run setup:live -- --admin you@gmail.com [--name "Your Name"] [--replace]');
  process.exit(1);
}
const config = loadConfig({ ...process.env, ENABLE_INTERNAL_SCHEDULER: 'false' });
if (config.APP_MODE !== 'local') throw new Error('setup:live is for the local app only. On a hosted server set FIRST_ADMIN_EMAIL instead.');
const sourceDir = config.LOCAL_DB_DIR ? resolve(config.LOCAL_DB_DIR) : DEFAULT_LOCAL_DIR;
const targetDir = join(DEFAULT_LOCAL_DIR, 'live');
if (resolve(sourceDir) === resolve(targetDir)) throw new Error('The app is already using the live database. Use --replace only from another database.');
if (existsSync(join(targetDir, 'local-db.tar.gz')) && !process.argv.includes('--replace')) {
  throw new Error(`${targetDir} already exists. Run with --replace to start it again from empty.`);
}

// ---- 1. The configuration to keep (secrets stay encrypted) -------------------------------------
const source = await createServices(config, { manualKick: true, quiet: true });
const kept = await source.db.asService(async (q) => ({
  ai: (await q.query<{ provider: string; model: string | null; api_key_ciphertext: string | null; api_key_hint: string | null }>(
    'select provider, model, api_key_ciphertext, api_key_hint from internal.ai_provider_config',
  ))[0],
  email: (await q.query<{ provider: string; from_name: string | null; from_address: string | null; secret_ciphertext: string | null; secret_hint: string | null }>(
    'select provider, from_name, from_address, secret_ciphertext, secret_hint from internal.email_sender_config',
  ))[0],
  rules: (await q.query<{ version: number; policy_rules: string[]; negative_constraints: string[] }>(
    'select version, policy_rules, negative_constraints from public.ai_rule_versions order by version desc limit 1',
  ))[0],
  settings: await q.query<{ key: string; value: unknown }>('select key, value from public.app_settings'),
  templates: await q.query<{ key: string; subject: string; body: string }>('select key, subject, body from public.notification_templates'),
}));
await source.stop();

// ---- 2. A new, empty database with the same encryption key -------------------------------------
mkdirSync(targetDir, { recursive: true });
for (const f of ['local-db.tar.gz', 'local-db.tar.gz.lock']) rmSync(join(targetDir, f), { force: true });
if (existsSync(join(sourceDir, 'local-secrets-key')) && !config.SECRETS_ENCRYPTION_KEY) {
  copyFileSync(join(sourceDir, 'local-secrets-key'), join(targetDir, 'local-secrets-key'));
}
const services = await createServices({ ...config, LOCAL_DB_DIR: targetDir, DEMO_MODE: false }, { manualKick: true, quiet: true });
try {
  await services.db.asService(async (q) => {
    if (kept.ai?.api_key_ciphertext) {
      await q.query('update internal.ai_provider_config set provider = $1, model = $2, api_key_ciphertext = $3, api_key_hint = $4, updated_at = now()', [
        kept.ai.provider, kept.ai.model, kept.ai.api_key_ciphertext, kept.ai.api_key_hint,
      ]);
    }
    if (kept.email?.secret_ciphertext && kept.email.provider !== 'none') {
      await q.query('update internal.email_sender_config set provider = $1, from_name = $2, from_address = $3, secret_ciphertext = $4, secret_hint = $5, updated_at = now()', [
        kept.email.provider, kept.email.from_name, kept.email.from_address, kept.email.secret_ciphertext, kept.email.secret_hint,
      ]);
    }
    for (const s of kept.settings) await q.query('update public.app_settings set value = $2::jsonb where key = $1', [s.key, JSON.stringify(s.value)]);
    for (const t of kept.templates) await q.query('update public.notification_templates set subject = $2, body = $3 where key = $1', [t.key, t.subject, t.body]);
    if (kept.rules && kept.rules.version > 1) {
      await q.query(
        `insert into public.ai_rule_versions (version, policy_rules, negative_constraints)
         select coalesce(max(version), 0) + 1, $1::text[], $2::text[] from public.ai_rule_versions`,
        [kept.rules.policy_rules, kept.rules.negative_constraints],
      );
    }
  });
  await services.email.load();

  // ---- 3. The administrator, invited by email ----------------------------------------------------
  const result = await ensureFirstAdmin(services, () => {}, { email: adminEmail, name: arg('name') });

  // ---- 4. Switch the local app to the new database -----------------------------------------------
  const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  const set = (text: string, key: string, value: string) =>
    new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  writeFileSync('.env', set(set(set(env, 'LOCAL_DB_DIR', `"${targetDir.replaceAll('\\', '/')}"`), 'DEMO_MODE', 'false'), 'FIRST_ADMIN_EMAIL', adminEmail.toLowerCase()));

  console.log(`\nLive database ready at ${targetDir} (no demo data).`);
  console.log(`Kept: AI ${kept.ai?.api_key_ciphertext ? `(${kept.ai.provider})` : 'not connected'}, email ${services.email.delivers ? `(${services.email.name}, ${kept.email?.from_address})` : 'not connected'}.`);
  if (result?.status === 'sent') console.log(`Invitation emailed to ${adminEmail}. Open it, choose a password, and you are signed in as the administrator.`);
  else console.log(`Email was not sent${result?.error ? ` (${result.error})` : ''}. Open this one-time link to choose the password:\n${result?.link}`);
  console.log(`The previous database is unchanged at ${sourceDir} (set LOCAL_DB_DIR back in backend/.env to return to it).`);
} finally {
  await services.stop();
}
