import { PGlite, types } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, Queryable } from './types';
import { userClaims } from './types';

/** Serializes transactions: PGlite has a single connection. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One process per snapshot file, so two dev servers never overwrite each other. */
function acquireLock(file: string) {
  const lock = `${file}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid && isRunning(pid)) {
      throw new Error(`The local database is in use by another process (pid ${pid}). Stop it first.`);
    }
  }
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

/**
 * LOCAL MODE database. PGlite runs in memory and, after any transaction that wrote data,
 * a compressed snapshot is saved atomically (temp file + rename). A dev-server restart on
 * Windows kills the process without a clean shutdown, which a live PGlite data directory
 * does not survive; a snapshot always does, losing at most the last couple of seconds.
 */
export async function createPgliteDb(snapshotFile: string | null): Promise<Db> {
  let release = () => {};
  let loadDataDir: Blob | undefined;
  if (snapshotFile) {
    mkdirSync(dirname(snapshotFile), { recursive: true });
    release = acquireLock(snapshotFile);
    if (existsSync(snapshotFile)) loadDataDir = new Blob([readFileSync(snapshotFile)]);
  }
  const pg = new PGlite({
    loadDataDir,
    // Keep DATE values as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
    parsers: { [types.DATE]: (v: string) => v },
  });
  await pg.waitReady;
  await pg.exec(`set timezone = 'UTC'`);
  const mutex = new Mutex();

  let timer: NodeJS.Timeout | null = null;
  let dirty = false;
  const persist = () =>
    mutex.run(async () => {
      if (!snapshotFile || !dirty) return;
      dirty = false;
      const file = await pg.dumpDataDir('gzip');
      const tmp = `${snapshotFile}.tmp`;
      writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
      renameSync(tmp, snapshotFile);
    });
  const markDirty = () => {
    if (!snapshotFile) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void persist().catch((e) => console.error('snapshot failed', e)), 1500);
  };

  const tx = <T>(prepare: (q: Queryable) => Promise<void>, fn: (q: Queryable) => Promise<T>) =>
    mutex.run(async () => {
      let wrote = false;
      const result = await pg.transaction(async (t) => {
        const q: Queryable = {
          query: async <R>(sql: string, params?: unknown[]) => (await t.query<R>(sql, params)).rows,
        };
        await prepare(q);
        const value = await fn(q);
        if (snapshotFile) {
          const [row] = (await t.query<{ w: boolean }>('select pg_current_xact_id_if_assigned() is not null as w')).rows;
          wrote = Boolean(row?.w);
        }
        return value;
      });
      if (wrote) markDirty();
      return result;
    });

  return {
    kind: 'pglite',
    asUser: (userId, fn) =>
      tx(async (q) => {
        await q.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
          userClaims(userId),
          userId,
        ]);
        await q.query('set local role authenticated');
      }, fn) as never,
    asService: (fn) => tx(async () => {}, fn) as never,
    exec: async (sql) => {
      await mutex.run(async () => void (await pg.exec(sql)));
      markDirty();
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      await persist();
      await pg.close();
      release();
    },
  };
}
