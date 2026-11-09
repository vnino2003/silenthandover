import { createHash, randomBytes } from 'node:crypto';
import { ROLE_LABELS, type Role } from '@sh/shared';
import { renderTemplate } from '../automation/notifications';
import { ApiError } from '../http/errors';
import type { Services } from '../http/context';

/** How long an invitation or reset link works. */
export const INVITE_DAYS = 7;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type InvitePurpose = 'invite' | 'reset';

export interface InviteResult {
  purpose: InvitePurpose;
  status: 'sent' | 'simulated' | 'failed';
  to: string;
  expires_at: string;
  error: string | null;
  /**
   * Returned only when the email did not really go out (no email sender connected, or it
   * failed), so the administrator can pass the link on another way.
   */
  link: string | null;
}

type Svc = Pick<Services, 'db' | 'config' | 'auth' | 'email'>;

/**
 * Creates a one-time link for this account and emails it. An account without a password gets an
 * invitation; one that already has a password gets a reset link (its password keeps working
 * until a new one is chosen). Any earlier open link for the account stops working.
 */
export async function sendInvitation(s: Svc, userId: string, actorId: string): Promise<InviteResult> {
  const token = randomBytes(32).toString('base64url');
  const withPassword = await s.auth.withPassword([userId]);
  const info = await s.db.asService(async (q) => {
    const [p] = await q.query<{ full_name: string; email: string; role: Role; is_active: boolean; department_name: string | null; accepted: boolean }>(
      `select p.full_name, p.email, p.role, p.is_active, d.name as department_name,
              exists (select 1 from internal.invitations i where i.user_id = p.id and i.accepted_at is not null) as accepted
         from public.profiles p left join public.departments d on d.id = p.department_id where p.id = $1`,
      [userId],
    );
    if (!p) throw new ApiError(404, 'not_found', 'User not found');
    if (!p.is_active) throw new ApiError(409, 'inactive', 'This account is deactivated. Activate it before sending a link.');
    const purpose: InvitePurpose = (withPassword ? withPassword.has(userId) : p.accepted) ? 'reset' : 'invite';
    await q.query('update internal.invitations set revoked_at = now() where user_id = $1 and accepted_at is null and revoked_at is null', [userId]);
    const [row] = await q.query<{ id: string; expires_at: string }>(
      `insert into internal.invitations (user_id, purpose, token_hash, expires_at, created_by)
       values ($1, $2, $3, now() + make_interval(days => $4), $5) returning id, expires_at`,
      [userId, purpose, hashToken(token), INVITE_DAYS, actorId],
    );
    const [inviter] = await q.query<{ full_name: string }>('select full_name from public.profiles where id = $1', [actorId]);
    const [tpl] = await q.query<{ subject: string; body: string }>('select subject, body from public.notification_templates where key = $1', [
      purpose === 'invite' ? 'invitation' : 'password_reset',
    ]);
    // The first administrator is set up by the server itself, not invited by a person.
    const inviterName = actorId === userId ? 'Your organization' : (inviter?.full_name ?? 'Your administrator');
    return { p, purpose, invitationId: row!.id, expiresAt: row!.expires_at, inviter: inviterName, tpl };
  });

  // The token is in the link's #fragment, which browsers never send to a server or in a Referer.
  const link = `${s.config.APP_BASE_URL}/set-password#token=${token}`;
  const expires = new Date(info.expiresAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
  const vars = {
    recipient_name: info.p.full_name,
    app_name: 'Silent Handover',
    role: ROLE_LABELS[info.p.role] ?? info.p.role,
    department: info.p.department_name ? ` in ${info.p.department_name}` : '',
    invited_by: info.inviter,
    link,
    expires,
  };
  const tpl = info.tpl ?? { subject: 'Silent Handover sign-in link', body: 'Hello {{recipient_name}},\n\nOpen this link to choose your password:\n{{link}}\n\nIt expires on {{expires}}.' };
  const result = await s.email.sendNow(info.p.email, renderTemplate(tpl.subject, vars).slice(0, 200), renderTemplate(tpl.body, vars));
  const status = result.status === 'sent' || result.status === 'simulated' ? result.status : 'failed';
  await s.db.asService(async (q) => {
    await q.query('update internal.invitations set sent_at = now(), send_status = $2, send_error = $3 where id = $1', [info.invitationId, status, result.error ?? null]);
    await q.query(
      `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details)
       select $1, coalesce((select role from public.profiles where id = $1), 'system'), $2, 'profile', $3, $4::jsonb`,
      [actorId, info.purpose === 'invite' ? 'user.invited' : actorId === userId ? 'user.reset_requested' : 'user.reset_link_sent', userId, JSON.stringify({ email: status, provider: result.provider })],
    );
  });
  return { purpose: info.purpose, status, to: info.p.email, expires_at: info.expiresAt, error: result.error ?? null, link: status === 'sent' ? null : link };
}

/** At most one self-service link per account in this many minutes. */
const RESET_COOLDOWN_MINUTES = 2;

/**
 * "Forgot password?" on the sign-in page. Emails a one-time link to an active account with this
 * address. The caller always answers the same way, so it does not reveal who has an account.
 * The link is never returned here: it only goes to the account's own inbox.
 */
export async function requestPasswordReset(s: Svc, email: string): Promise<'sent' | 'skipped'> {
  const [row] = await s.db.asService((q) =>
    q.query<{ id: string; recent: boolean }>(
      `select p.id, exists (select 1 from internal.invitations i where i.user_id = p.id
                              and i.created_at > now() - make_interval(mins => $2)) as recent
         from public.profiles p where lower(p.email) = lower($1) and p.is_active`,
      [email.trim(), RESET_COOLDOWN_MINUTES],
    ),
  );
  if (!row || row.recent) return 'skipped';
  const result = await sendInvitation(s, row.id, row.id);
  return result.status === 'sent' ? 'sent' : 'skipped';
}

export async function revokeInvitations(s: Pick<Services, 'db'>, userId: string, actorId: string): Promise<number> {
  return s.db.asService(async (q) => {
    const rows = await q.query('update internal.invitations set revoked_at = now() where user_id = $1 and accepted_at is null and revoked_at is null returning id', [userId]);
    if (rows.length) {
      await q.query(
        `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details) values ($1, 'admin', 'user.invitation_revoked', 'profile', $2, '{}'::jsonb)`,
        [actorId, userId],
      );
    }
    return rows.length;
  });
}

export interface SignInState {
  /** ready: can sign in. invited: waiting for the person to choose a password. expired: the link stopped working. */
  sign_in: 'ready' | 'invited' | 'expired';
  invitation: { purpose: InvitePurpose; sent_at: string | null; expires_at: string; send_status: string | null; send_error: string | null } | null;
}

/** For the Users list: whether each account can sign in, and any open link. */
export async function signInStates(s: Pick<Services, 'db' | 'auth'>, userIds: string[]): Promise<Map<string, SignInState>> {
  const withPassword = await s.auth.withPassword(userIds);
  const [latest] = await Promise.all([
    s.db.asService((q) =>
      q.query<{ user_id: string; purpose: InvitePurpose; sent_at: string | null; expires_at: string; send_status: string | null; send_error: string | null; open: boolean; ever_accepted: boolean }>(
        `select distinct on (i.user_id) i.user_id, i.purpose, i.sent_at, i.expires_at, i.send_status, i.send_error,
                (i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) as open,
                exists (select 1 from internal.invitations a where a.user_id = i.user_id and a.accepted_at is not null) as ever_accepted
           from internal.invitations i where i.user_id = any($1::uuid[])
          order by i.user_id, i.created_at desc`,
        [userIds],
      ),
    ),
  ]);
  const byUser = new Map(latest.map((r) => [r.user_id, r]));
  const out = new Map<string, SignInState>();
  for (const id of userIds) {
    const inv = byUser.get(id);
    // Supabase cannot tell us about passwords: accounts never invited, or that accepted once, can sign in.
    const hasPassword = withPassword ? withPassword.has(id) : !inv || inv.ever_accepted;
    const open = inv?.open ? { purpose: inv.purpose, sent_at: inv.sent_at, expires_at: inv.expires_at, send_status: inv.send_status, send_error: inv.send_error } : null;
    out.set(id, { sign_in: hasPassword ? 'ready' : open ? 'invited' : 'expired', invitation: open });
  }
  return out;
}

export interface InvitationPreview {
  full_name: string;
  email: string;
  role: string;
  department_name: string | null;
  purpose: InvitePurpose;
  expires_at: string;
}

function linkProblem(row: { accepted_at: string | null; revoked_at: string | null; expires_at: string; is_active: boolean } | undefined): ApiError | null {
  if (!row) return new ApiError(404, 'invalid_link', 'This link is not valid. Ask your administrator to send a new one.');
  if (row.accepted_at) return new ApiError(410, 'link_used', 'This link was already used. Sign in with the password you chose.');
  if (row.revoked_at) return new ApiError(410, 'link_replaced', 'This link was replaced by a newer one. Use the latest email, or ask your administrator to send a new link.');
  if (new Date(row.expires_at).getTime() <= Date.now()) return new ApiError(410, 'link_expired', 'This link has expired. Ask your administrator to send a new one.');
  if (!row.is_active) return new ApiError(403, 'inactive', 'This account is deactivated. Contact your administrator.');
  return null;
}

/** What the set-password page shows before the person chooses a password. */
export async function previewInvitation(s: Pick<Services, 'db'>, token: string): Promise<InvitationPreview> {
  const [row] = await s.db.asService((q) =>
    q.query<InvitationPreview & { accepted_at: string | null; revoked_at: string | null; is_active: boolean; role: Role }>(
      `select p.full_name, p.email, p.role, d.name as department_name, p.is_active, i.purpose, i.expires_at, i.accepted_at, i.revoked_at
         from internal.invitations i join public.profiles p on p.id = i.user_id left join public.departments d on d.id = p.department_id
        where i.token_hash = $1`,
      [hashToken(token)],
    ),
  );
  const problem = linkProblem(row);
  if (problem) throw problem;
  return { full_name: row!.full_name, email: row!.email, role: ROLE_LABELS[row!.role] ?? row!.role, department_name: row!.department_name, purpose: row!.purpose, expires_at: row!.expires_at };
}

/** Sets the password and uses up the link. Returns the account's email for signing in. */
export async function acceptInvitation(s: Pick<Services, 'db' | 'auth'>, token: string, password: string): Promise<{ userId: string; email: string }> {
  const hash = hashToken(token);
  // Claim the link first, atomically, so the same link cannot be used twice at once.
  const claimed = await s.db.asService(async (q) => {
    const [row] = await q.query<{ id: string; user_id: string; email: string; accepted_at: string | null; revoked_at: string | null; expires_at: string; is_active: boolean }>(
      `select i.id, i.user_id, p.email, i.accepted_at, i.revoked_at, i.expires_at, p.is_active
         from internal.invitations i join public.profiles p on p.id = i.user_id where i.token_hash = $1 for update of i`,
      [hash],
    );
    const problem = linkProblem(row);
    if (problem) throw problem;
    await q.query('update internal.invitations set accepted_at = now() where id = $1', [row!.id]);
    return row!;
  });
  try {
    await s.auth.setPassword(claimed.user_id, password);
  } catch (err) {
    // The password was not saved: the link keeps working.
    await s.db.asService((q) => q.query('update internal.invitations set accepted_at = null where id = $1', [claimed.id]));
    throw err;
  }
  await s.db.asService((q) =>
    q.query(
      `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details)
       select p.id, p.role, 'user.password_set', 'profile', p.id, '{}'::jsonb from public.profiles p where p.id = $1`,
      [claimed.user_id],
    ),
  );
  return { userId: claimed.user_id, email: claimed.email };
}
