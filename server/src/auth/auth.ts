import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from '../config';
import type { Db } from '../db/types';
import { ApiError } from '../http/errors';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface AuthProvider {
  readonly mode: 'local' | 'supabase';
  verify(token: string): Promise<string>;
  /**
   * Creates a sign-in identity and returns its user id. The profile is created separately.
   * Without a password the account cannot sign in until the person sets one from an invitation.
   */
  createUser(email: string, password?: string): Promise<string>;
  /** Sets or replaces the password (from an invitation or reset link). */
  setPassword(userId: string, password: string): Promise<void>;
  /** Which of these accounts can sign in with a password today. */
  withPassword(userIds: string[]): Promise<Set<string> | null>;
  login?(email: string, password: string): Promise<{ token: string; expires_at: string }>;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

const TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** LOCAL MODE ONLY: test accounts stored in the embedded database. */
export function createLocalAuth(db: Db, secret: string): AuthProvider {
  const key = new TextEncoder().encode(secret);
  return {
    mode: 'local',
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: 'silent-handover-local', audience: 'authenticated' });
        if (!payload.sub) throw new Error('no sub');
        return payload.sub;
      } catch {
        throw new ApiError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
      }
    },
    async createUser(email, password) {
      const hash = password ? await hashPassword(password) : null;
      return db.asService(async (q) => {
        const [user] = await q.query<{ id: string }>('insert into auth.users (email) values (lower($1)) returning id', [email]);
        if (hash) await q.query('insert into local_auth.credentials (user_id, password_hash) values ($1, $2)', [user!.id, hash]);
        return user!.id;
      });
    },
    async setPassword(userId, password) {
      const hash = await hashPassword(password);
      await db.asService((q) =>
        q.query(
          `insert into local_auth.credentials (user_id, password_hash) values ($1, $2)
           on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = now()`,
          [userId, hash],
        ),
      );
    },
    async withPassword(userIds) {
      if (!userIds.length) return new Set();
      const rows = await db.asService((q) => q.query<{ user_id: string }>('select user_id from local_auth.credentials where user_id = any($1::uuid[])', [userIds]));
      return new Set(rows.map((r) => r.user_id));
    },
    async login(email, password) {
      const row = await db.asService(async (q) => {
        const rows = await q.query<{ id: string; password_hash: string; is_active: boolean | null }>(
          `select u.id, c.password_hash, p.is_active
             from auth.users u
             join local_auth.credentials c on c.user_id = u.id
             left join public.profiles p on p.id = u.id
            where u.email = lower($1)`,
          [email],
        );
        return rows[0];
      });
      // Same error for unknown email, wrong password and deactivated accounts.
      const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, DUMMY_HASH);
      if (!row || !ok || !row.is_active) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
      const token = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(row.id)
        .setIssuer('silent-handover-local')
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(key);
      return { token, expires_at: new Date(exp * 1000).toISOString() };
    },
  };
}

const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/** Production: Supabase Auth issues tokens; the API only verifies them. */
export function createSupabaseAuth(config: Config): AuthProvider {
  const issuer = `${config.SUPABASE_URL}/auth/v1`;
  const secret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;
  const jwks = secret ? null : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const adminHeaders = {
    apikey: config.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  return {
    mode: 'supabase',
    async verify(token) {
      try {
        const { payload } = secret
          ? await jwtVerify(token, secret, { audience: 'authenticated', issuer })
          : await jwtVerify(token, jwks!, { audience: 'authenticated', issuer });
        if (!payload.sub) throw new Error('no sub');
        return payload.sub;
      } catch {
        throw new ApiError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
      }
    },
    async createUser(email, password) {
      const res = await fetch(`${issuer}/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        // Invited accounts get a long random password nobody knows until they choose their own.
        body: JSON.stringify({ email, password: password ?? randomBytes(32).toString('base64url'), email_confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; msg?: string };
      if (!res.ok || !body.id) {
        throw new ApiError(res.status === 422 ? 409 : 502, 'auth_provider', 'The sign-in account could not be created');
      }
      return body.id;
    },
    async setPassword(userId, password) {
      const res = await fetch(`${issuer}/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new ApiError(502, 'auth_provider', 'The password could not be saved. Please try again.');
    },
    // Supabase does not say whether a password was chosen; invitations track it instead.
    async withPassword() {
      return null;
    },
  };
}
