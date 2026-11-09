import { maskAddress } from '../automation/notifications';
import type { Services } from '../http/context';
import { sendInvitation, signInStates } from './invitations';

type Log = (m: string, e?: Record<string, unknown>) => void;

/** "maria.santos@example.com" -> "Maria" (the administrator can change it on Users). */
export function nameFromEmail(email: string): string {
  const first = email.split('@')[0]!.split(/[._-]+/)[0] ?? 'Administrator';
  return first.length >= 2 ? first[0]!.toUpperCase() + first.slice(1).toLowerCase() : 'Administrator';
}

/**
 * Starts a new organization with one administrator and no demo data: FIRST_ADMIN_EMAIL gets an
 * account without a password and an invitation to choose one. Everyone else is then added by
 * that administrator on the Users page.
 *
 * Runs at every start but only acts when needed: it creates the account only while the
 * organization has no active administrator, and sends a new invitation only if that account
 * still has no password and its last link has expired. When email is not connected yet, the
 * one-time link is written to the server log instead.
 */
export async function ensureFirstAdmin(s: Pick<Services, 'db' | 'auth' | 'config' | 'email'>, log: Log, opts: { email?: string; name?: string } = {}) {
  const email = (opts.email ?? s.config.FIRST_ADMIN_EMAIL)?.trim().toLowerCase();
  if (!email) return null;
  // The link would point nowhere: wait until APP_BASE_URL is the real web address.
  if (/(^|\.)example\.(com|org)$/i.test(new URL(s.config.APP_BASE_URL).hostname)) {
    log('First administrator not invited yet: set APP_BASE_URL to the web app address first');
    return null;
  }
  const [existing] = await s.db.asService((q) =>
    q.query<{ id: string; role: string; is_active: boolean }>('select id, role, is_active from public.profiles where lower(email) = $1', [email]),
  );
  let userId: string;
  if (!existing) {
    const [{ admins }] = (await s.db.asService((q) => q.query<{ admins: number }>("select count(*)::int as admins from public.profiles where role = 'admin' and is_active"))) as [{ admins: number }];
    if (admins > 0) {
      log('FIRST_ADMIN_EMAIL ignored: an administrator already exists. Add people on the Users page.');
      return null;
    }
    userId = await s.auth.createUser(email);
    const name = opts.name ?? s.config.FIRST_ADMIN_NAME ?? nameFromEmail(email);
    await s.db.asService(async (q) => {
      await q.query(`insert into public.profiles (id, full_name, email, role) values ($1, $2, $3, 'admin')`, [userId, name, email]);
      await q.query(
        `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details) values (null, 'system', 'user.first_admin_created', 'profile', $1, '{}'::jsonb)`,
        [userId],
      );
    });
    log('first administrator created', { to: maskAddress(email) });
  } else {
    if (existing.role !== 'admin' || !existing.is_active) {
      log('FIRST_ADMIN_EMAIL ignored: that account is not an active administrator');
      return null;
    }
    userId = existing.id;
    // Already signed in once, or an invitation is still waiting: nothing to do.
    if ((await signInStates(s, [userId])).get(userId)!.sign_in !== 'expired') return null;
  }
  const result = await sendInvitation(s, userId, userId);
  if (result.status === 'sent') log('first administrator invited by email', { to: maskAddress(email), expires_at: result.expires_at });
  // Email is not connected on a brand-new server: the administrator opens the link from the log.
  else log('FIRST ADMINISTRATOR: email was not sent. Open this one-time link to choose the password', { link: result.link, error: result.error });
  return result;
}
