export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db {
  readonly kind: 'pglite' | 'postgres';
  /**
   * Runs fn in a transaction as the `authenticated` role with the user's id in
   * request.jwt.claims — the same context PostgREST uses — so RLS and auth.uid() apply.
   */
  asUser<T>(userId: string, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs fn in a transaction with the owner connection. Only for automation and auth plumbing. */
  asService<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Raw multi-statement execution (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function userClaims(userId: string): string {
  return JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' });
}
