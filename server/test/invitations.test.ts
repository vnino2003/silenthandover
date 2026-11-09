import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD } from '../src/seed/demo';
import { setup, type Harness } from './helpers';

/** Every email the stub SMTP server "sent", and the login it was given. */
const mailbox: { auth: { user: string; pass: string }; mail: Record<string, any> }[] = [];
let smtpFails: Error | null = null;

const tokenOf = (link: string) => new URL(link).hash.replace('#token=', '');
const linkIn = (text: string) => text.match(/https?:\/\/\S+set-password#token=[A-Za-z0-9_-]+/)![0];

describe('account invitations and the email sender', () => {
  let h: Harness;
  let deptId: string;

  beforeAll(async () => {
    h = await setup({}, undefined, (options) => ({
      async sendMail(mail) {
        if (smtpFails) throw smtpFails;
        mailbox.push({ auth: options.auth, mail });
        return { messageId: `<m${mailbox.length}@test>` };
      },
    }));
    const [d] = await h.sql<{ id: string }>('select department_id as id from public.profiles where id = $1', [h.ids.juan]);
    deptId = d!.id;
  });
  afterAll(() => h.close());

  const login = (email: string, password: string) =>
    h.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const post = (path: string, body: unknown) =>
    h.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('creates an account without a password and returns the link while email is not connected', async () => {
    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: 'Rosa Villanueva', email: 'rosa.v@demo.test', role: 'manager', department_id: deptId });
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ purpose: 'invite', status: 'simulated', to: 'rosa.v@demo.test' });
    expect(res.body.invite.link).toMatch(/\/set-password#token=/);

    // Nobody can sign in to it yet, not even with a guessed password.
    expect((await login('rosa.v@demo.test', DEMO_PASSWORD)).status).toBe(401);

    const users = (await h.call('admin', 'GET', '/api/admin/users')).body as any[];
    const rosa = users.find((u) => u.email === 'rosa.v@demo.test');
    expect(rosa.sign_in).toBe('invited');
    expect(rosa.invitation.purpose).toBe('invite');
    expect(users.find((u) => u.id === h.ids.juan).sign_in).toBe('ready');

    // Only a hash of the token is stored.
    const token = tokenOf(res.body.invite.link);
    const stored = await h.sql<{ token_hash: string }>('select token_hash from internal.invitations');
    expect(stored.some((r) => r.token_hash === token)).toBe(false);
  });

  it('lets the invited person choose a password once and signs them in', async () => {
    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: 'Paolo Cruz', email: 'paolo.c@demo.test', role: 'employee', department_id: deptId });
    const token = tokenOf(res.body.invite.link);

    const check = await post('/api/invitations/check', { token });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ full_name: 'Paolo Cruz', email: 'paolo.c@demo.test', purpose: 'invite' });

    expect((await post('/api/invitations/accept', { token, password: 'short' })).status).toBe(422);
    const ok = await post('/api/invitations/accept', { token, password: 'paolo-chose-this-1' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { session: { token: string } };
    const me = await h.app.request('/api/me', { headers: { Authorization: `Bearer ${body.session.token}` } });
    expect(((await me.json()) as { email: string }).email).toBe('paolo.c@demo.test');

    // The link works only once.
    expect((await post('/api/invitations/accept', { token, password: 'another-password-2' })).status).toBe(410);
    expect((await post('/api/invitations/check', { token })).status).toBe(410);
    expect((await login('paolo.c@demo.test', 'paolo-chose-this-1')).status).toBe(200);
  });

  it('rejects unknown, revoked and expired links', async () => {
    expect((await post('/api/invitations/check', { token: 'x'.repeat(43) })).status).toBe(404);
    expect((await post('/api/invitations/check', { token: 'bad token!' })).status).toBe(404);

    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: 'Lea Ramos', email: 'lea.r@demo.test', role: 'employee', department_id: deptId });
    const first = tokenOf(res.body.invite.link);
    // Sending again replaces the earlier link.
    const again = await h.call('admin', 'POST', `/api/admin/users/${res.body.id}/invite`);
    expect(again.status).toBe(200);
    expect((await post('/api/invitations/check', { token: first })).status).toBe(410);
    const second = tokenOf(again.body.link);
    expect((await post('/api/invitations/check', { token: second })).status).toBe(200);

    expect((await h.call('admin', 'POST', `/api/admin/users/${res.body.id}/invite/revoke`)).body.revoked).toBe(1);
    expect((await post('/api/invitations/accept', { token: second, password: 'lea-password-123' })).status).toBe(410);

    const third = tokenOf((await h.call('admin', 'POST', `/api/admin/users/${res.body.id}/invite`)).body.link);
    await h.sql("update internal.invitations set expires_at = now() - interval '1 minute' where accepted_at is null and revoked_at is null");
    const expired = await post('/api/invitations/check', { token: third });
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as any).error.code).toBe('link_expired');
    const users = (await h.call('admin', 'GET', '/api/admin/users')).body as any[];
    expect(users.find((u) => u.id === res.body.id).sign_in).toBe('expired');
  });

  it('sends a password reset link to an account that already has a password', async () => {
    const res = await h.call('admin', 'POST', `/api/admin/users/${h.ids.ana}/invite`);
    expect(res.body.purpose).toBe('reset');
    // The current password keeps working until a new one is chosen.
    expect((await login('ana.lim@demo.test', DEMO_PASSWORD)).status).toBe(200);
    expect((await post('/api/invitations/accept', { token: tokenOf(res.body.link), password: 'ana-new-password-9' })).status).toBe(200);
    expect((await login('ana.lim@demo.test', DEMO_PASSWORD)).status).toBe(401);
    expect((await login('ana.lim@demo.test', 'ana-new-password-9')).status).toBe(200);
  });

  it('is for administrators only', async () => {
    expect((await h.call('juan', 'POST', `/api/admin/users/${h.ids.ana}/invite`)).status).toBe(403);
    expect((await h.call('manager', 'GET', '/api/admin/email')).status).toBe(403);
    expect((await h.call('manager', 'POST', '/api/admin/users', { full_name: 'X Y', email: 'x.y@demo.test', role: 'employee', department_id: deptId })).status).toBe(403);
  });

  it('connects Gmail with an App Password that is stored encrypted and never returned', async () => {
    expect((await h.call('admin', 'GET', '/api/admin/email')).body).toMatchObject({ provider: 'none', simulated: true, active: 'dev' });

    const wrongLength = await h.call('admin', 'PUT', '/api/admin/email', { provider: 'gmail', from_address: 'handover.team@gmail.com', secret: 'abcd efgh ijkl' });
    expect(wrongLength.status).toBe(422);
    const missing = await h.call('admin', 'PUT', '/api/admin/email', { provider: 'gmail', from_address: 'handover.team@gmail.com' });
    expect(missing.status).toBe(422);

    const saved = await h.call('admin', 'PUT', '/api/admin/email', { provider: 'gmail', from_name: 'Starlight Handover', from_address: 'handover.team@gmail.com', secret: 'abcd efgh ijkl mnop' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: 'gmail', has_secret: true, secret_hint: 'mnop', active: 'gmail', simulated: false });
    expect(JSON.stringify(saved.body)).not.toContain('abcd');
    const [row] = await h.sql<{ secret_ciphertext: string }>('select secret_ciphertext from internal.email_sender_config');
    expect(row!.secret_ciphertext).not.toContain('abcd');

    // Saving again without the secret keeps it.
    expect((await h.call('admin', 'PUT', '/api/admin/email', { provider: 'gmail', from_name: 'Handover', from_address: 'handover.team@gmail.com' })).body.has_secret).toBe(true);

    const test = await h.call('admin', 'POST', '/api/admin/email/test', { provider: 'gmail', from_name: 'Handover', from_address: 'handover.team@gmail.com', to: 'someone@example.com' });
    expect(test.body).toMatchObject({ ok: true, error: null });
    const last = mailbox.at(-1)!;
    expect(last.auth).toEqual({ user: 'handover.team@gmail.com', pass: 'abcdefghijklmnop' });
    expect(last.mail.to).toBe('someone@example.com');
  });

  it('emails invitations through Gmail and stops showing the link to the administrator', async () => {
    const before = mailbox.length;
    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: 'Mila Santos', email: 'mila.s@demo.test', role: 'employee', department_id: deptId });
    expect(res.body.invite).toMatchObject({ status: 'sent', link: null });
    expect(mailbox.length).toBe(before + 1);
    const mail = mailbox.at(-1)!.mail;
    expect(mail.to).toBe('mila.s@demo.test');
    expect(mail.subject).toContain('invited');
    expect(mail.text).toContain('Hello Mila Santos');
    expect(mail.html).toContain('Open link');
    const token = tokenOf(linkIn(mail.text));
    expect((await post('/api/invitations/accept', { token, password: 'mila-password-42' })).status).toBe(200);

    // Ordinary notifications now go out through Gmail too.
    expect(h.services.notifications.transportName).toBe('gmail');
  });

  it('explains a rejected Gmail sign-in and still gives the administrator the link', async () => {
    smtpFails = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    try {
      const test = await h.call('admin', 'POST', '/api/admin/email/test', { provider: 'gmail', from_address: 'handover.team@gmail.com', to: 'someone@example.com' });
      expect(test.body.ok).toBe(false);
      expect(test.body.error).toContain('App Password');
      const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: 'Nina Cruz', email: 'nina.c@demo.test', role: 'employee', department_id: deptId });
      expect(res.body.invite.status).toBe('failed');
      expect(res.body.invite.link).toMatch(/set-password#token=/);
    } finally {
      smtpFails = null;
    }
  });

  it('starts a real organization with only the first administrator, invited by email', async () => {
    const { createServices } = await import('../src/bootstrap');
    const { loadConfig } = await import('../src/config');
    const { ensureFirstAdmin } = await import('../src/auth/first-admin');
    const sent: Record<string, any>[] = [];
    const fresh = await createServices(
      loadConfig({ NODE_ENV: 'test', APP_MODE: 'local', DEMO_MODE: 'false', ENABLE_INTERNAL_SCHEDULER: 'false', EMAIL_TRANSPORT: 'gmail', GMAIL_USER: 'team@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', FIRST_ADMIN_EMAIL: 'Owner.Person@Gmail.com' }),
      { memory: true, quiet: true, manualKick: true, smtp: () => ({ sendMail: async (m) => (sent.push(m), { messageId: 'x' }) }) },
    );
    try {
      const logs: string[] = [];
      const first = await ensureFirstAdmin(fresh, (m) => logs.push(m));
      expect(first).toMatchObject({ purpose: 'invite', status: 'sent', link: null });
      const people = await fresh.db.asService((q) => q.query<{ full_name: string; email: string; role: string }>('select full_name, email, role from public.profiles'));
      expect(people).toEqual([{ full_name: 'Owner', email: 'owner.person@gmail.com', role: 'admin' }]);
      expect(await fresh.db.asService((q) => q.query('select id from public.departments'))).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe('owner.person@gmail.com');
      expect(sent[0]!.text).toContain('Your organization created your Silent Handover account');

      // Restarting changes nothing while the invitation is open or once a password is set.
      expect(await ensureFirstAdmin(fresh, () => {})).toBeNull();
      expect(sent).toHaveLength(1);
      // An expired invitation is sent again on the next start.
      await fresh.db.asService((q) => q.query("update internal.invitations set expires_at = now() - interval '1 minute'"));
      expect((await ensureFirstAdmin(fresh, () => {}))?.status).toBe('sent');
      expect(sent).toHaveLength(2);

      // Another address is ignored once an administrator exists.
      expect(await ensureFirstAdmin(fresh, (m) => logs.push(m), { email: 'someone.else@gmail.com' })).toBeNull();
      expect(logs.at(-1)).toContain('already exists');
    } finally {
      await fresh.stop();
    }
  });

  it('emails a reset link from "Forgot password?" without revealing who has an account', async () => {
    const before = mailbox.length;
    const unknown = await post('/api/auth/forgot-password', { email: 'nobody.here@demo.test' });
    expect(unknown.status).toBe(200);
    const known = await post('/api/auth/forgot-password', { email: 'Ben.Torres@demo.test' });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    // The email goes out after the answer.
    await new Promise((r) => setTimeout(r, 300));
    expect(mailbox.length).toBe(before + 1);
    const mail = mailbox.at(-1)!.mail;
    expect(mail.to).toBe('ben.torres@demo.test');
    const token = tokenOf(linkIn(mail.text));
    expect(((await (await post('/api/invitations/check', { token })).json()) as any).purpose).toBe('reset');

    // A second request within a couple of minutes sends nothing more.
    await post('/api/auth/forgot-password', { email: 'ben.torres@demo.test' });
    await new Promise((r) => setTimeout(r, 300));
    expect(mailbox.length).toBe(before + 1);

    expect((await post('/api/invitations/accept', { token, password: 'ben-new-password-7' })).status).toBe(200);
    expect((await login('ben.torres@demo.test', 'ben-new-password-7')).status).toBe(200);
    expect((await post('/api/auth/forgot-password', { email: 'not an email' })).status).toBe(422);
  });

  it('turns email back off', async () => {
    const off = await h.call('admin', 'PUT', '/api/admin/email', { provider: 'none' });
    expect(off.body).toMatchObject({ provider: 'none', has_secret: false, active: 'dev', simulated: true });
    expect(h.services.notifications.transportName).toBe('dev');
  });
});
