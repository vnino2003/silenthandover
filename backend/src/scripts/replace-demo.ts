import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServices, DEFAULT_LOCAL_DIR } from '../bootstrap';
import { loadConfig } from '../config';
import { seedDemo } from '../seed/demo';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig({ ...process.env, ENABLE_INTERNAL_SCHEDULER: 'false' });
if (config.APP_MODE !== 'local' || !config.DEMO_MODE) throw new Error('Demo replacement is available only for the local demo');
const previousDir = config.LOCAL_DB_DIR ? resolve(config.LOCAL_DB_DIR) : DEFAULT_LOCAL_DIR;
const previous = await createServices(config, { manualKick: true });
let alreadyInstalled = false;
let provider: { provider:string; model:string|null; api_key_ciphertext:string|null; api_key_hint:string|null } | undefined;
try {
  const departments = await previous.db.asService(q => q.query<{code:string}>('select code from public.departments'));
  alreadyInstalled = departments.some(d => d.code === 'NC') && !departments.some(d => d.code === 'WH');
  [provider] = await previous.db.asService(q => q.query<typeof provider & {}>('select provider,model,api_key_ciphertext,api_key_hint from internal.ai_provider_config'));
} finally { await previous.stop(); }
if (alreadyInstalled) console.log('The Newborn Care demo is already installed. No activity was replaced.');
else {
  // Keep the entire previous database, including custom accounts, activity and configuration.
  // Switch the local demo to a separate database rather than deleting or rewriting history.
  const targetDir = join(DEFAULT_LOCAL_DIR,'newborn-care-demo');
  mkdirSync(targetDir,{recursive:true});
  if (provider?.api_key_ciphertext && existsSync(join(previousDir,'local-secrets-key')) && !config.SECRETS_ENCRYPTION_KEY) copyFileSync(join(previousDir,'local-secrets-key'),join(targetDir,'local-secrets-key'));
  const fresh = await createServices({...config,LOCAL_DB_DIR:targetDir},{manualKick:true});
  try {
    await seedDemo(fresh,{onlyIfEmpty:true,sampleActivity:true,presentation:true});
    if (provider?.api_key_ciphertext) await fresh.db.asService(q => q.query('update internal.ai_provider_config set provider=$1,model=$2,api_key_ciphertext=$3,api_key_hint=$4,updated_at=now()', [provider!.provider,provider!.model,provider!.api_key_ciphertext,provider!.api_key_hint]));
  }
  finally { await fresh.stop(); }
  const line = `LOCAL_DB_DIR="${targetDir.replaceAll('\\','/')}"`;
  const current = existsSync('.env') ? readFileSync('.env','utf8') : '';
  const next = /^LOCAL_DB_DIR=.*$/m.test(current) ? current.replace(/^LOCAL_DB_DIR=.*$/m,line) : `${current.trimEnd()}\n${line}\n`;
  writeFileSync('.env',next);
  console.log(`Previous local database preserved at ${previousDir}`);
  console.log(`Newborn Care demo installed at ${targetDir}. Local configuration now selects it.`);
}
