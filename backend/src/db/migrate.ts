import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types';

const here = dirname(fileURLToPath(import.meta.url));

function findMigrationsDir(): string {
  // Works from src/ (tsx) and from dist/ (bundled).
  for (const candidate of [resolve(here, '../../../supabase/migrations'), resolve(here, '../../supabase/migrations')]) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error('supabase/migrations directory not found');
}

function findShim(): string {
  for (const candidate of [join(here, 'local-shim.sql'), resolve(here, '../src/db/local-shim.sql')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('local-shim.sql not found');
}

/** Applies the local auth shim (local mode only) and any migrations not yet recorded. */
export async function migrate(db: Db, opts: { localShim: boolean; log?: (m: string) => void }): Promise<string[]> {
  const log = opts.log ?? (() => {});
  if (opts.localShim) await db.exec(findShim());
  else await db.exec('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())');

  const dir = findMigrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    await db.asService(async (q) => (await q.query<{ name: string }>('select name from public.schema_migrations')).map((r) => r.name)),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.exec(`begin;\n${sql}\ninsert into public.schema_migrations (name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    log(`applied ${file}`);
    ran.push(file);
  }
  return ran;
}
