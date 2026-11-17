import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD } from '../src/seed/demo';
import { setup, type Harness } from './helpers';

/**
 * Sessions: signing out ends the session on the server, so a kept or restored copy of the token
 * (for example from a phone backup) is refused, and each sign-in is its own session.
 */
describe('sessions', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => h?.close());

  const login = async (email: string) => {
    const res = await h.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: DEMO_PASSWORD }) });
    return (await res.json()) as { token: string; expires_at: string };
  };
  const me = (token: string) => h.app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const logout = (token?: string) => h.app.request('/api/auth/logout', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('refuses a token after its session was signed out, everywhere', async () => {
    const a = await login('admin@demo.test');
    const copy = a.token; // e.g. a restored backup of the same session
    expect((await me(a.token)).status).toBe(200);
    expect((await logout(a.token)).status).toBe(200);
    expect((await me(a.token)).status).toBe(401);
    expect((await me(copy)).status).toBe(401);
  });

  it('keeps other sessions working, and each sign-in is a separate session for its own account', async () => {
    const one = await login('juan.delacruz@demo.test');
    const two = await login('juan.delacruz@demo.test');
    const admin = await login('admin@demo.test');
    expect(one.token).not.toBe(two.token);
    await logout(one.token);
    expect((await me(one.token)).status).toBe(401);
    const still = await me(two.token);
    expect(still.status).toBe(200);
    expect(((await still.json()) as { role: string }).role).toBe('employee');
    expect(((await (await me(admin.token)).json()) as { role: string }).role).toBe('admin');
  });

  it('answers sign-out without a valid token without error', async () => {
    expect((await logout()).status).toBe(200);
    expect((await logout('not-a-token')).status).toBe(200);
  });
});
