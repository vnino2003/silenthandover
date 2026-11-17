import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/automation/web-push';
import { setup, type Harness } from './helpers';

const b64u = (b: Buffer) => b.toString('base64url');
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** A browser's side of a subscription: its key pair and auth secret, and RFC 8291 decryption. */
function fakeDevice(endpoint: string) {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } },
    decrypt(body: Buffer): any {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const data = body.subarray(21 + idlen);
      const ecdhSecret = ua.computeSecret(asPublic);
      const ikm = hmac(hmac(auth, ecdhSecret), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
      expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
      return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
    },
  };
}

describe('web push encryption and VAPID', () => {
  it('encrypts a payload that only the subscribed device can read', () => {
    const dev = fakeDevice('https://push.example.test/1');
    const body = encryptPayload(Buffer.from(JSON.stringify({ title: 'Hello' })), dev.subscription.keys.p256dh, dev.subscription.keys.auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(dev.decrypt(body)).toEqual({ title: 'Hello' });
    const other = fakeDevice('https://push.example.test/2');
    expect(() => other.decrypt(body)).toThrow();
  });

  it('signs a VAPID token the push service can verify with the public key', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:push@localhost', 1_800_000_000);
    const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:push@localhost' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true);
  });
});

describe('phone alerts', () => {
  let h: Harness;
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  let status = 201;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).startsWith('https://push.example.test/')) {
      sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  let vacation: string;
  let day: (offset: number) => string;

  beforeAll(async () => {
    h = await setup({}, fetchImpl);
    const today = (await h.sql<{ today: string }>(`select (now() at time zone 'Asia/Manila')::date::text as today`))[0]!.today;
    day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    vacation = (await h.call('juan', 'GET', '/api/leave-types')).body.find((t: any) => t.name === 'Vacation leave').id;
  });
  afterAll(async () => h?.close());
  beforeEach(() => {
    sent.length = 0;
    status = 201;
  });

  it('gives every role the server key, and keeps devices to their owner', async () => {
    for (const who of ['juan', 'manager', 'admin']) {
      const res = await h.call(who, 'GET', '/api/me/push');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(Buffer.from(res.body.public_key, 'base64url')).toHaveLength(65);
    }
    expect((await h.call(null, 'GET', '/api/me/push')).status).toBe(401);
    const dev = fakeDevice('https://push.example.test/juan-phone');
    expect((await h.call('juan', 'PUT', '/api/me/push', { ...dev.subscription, device_label: 'Chrome on Android' })).status).toBe(200);
    expect((await h.call('juan', 'GET', '/api/me/push')).body.devices).toHaveLength(1);
    expect((await h.call('manager', 'GET', '/api/me/push')).body.devices).toHaveLength(0);
    // Someone else cannot remove it.
    await h.call('manager', 'DELETE', '/api/me/push', { endpoint: dev.subscription.endpoint });
    expect((await h.call('juan', 'GET', '/api/me/push')).body.devices).toHaveLength(1);
    expect((await h.call('juan', 'PUT', '/api/me/push', { endpoint: 'http://insecure.test/x', keys: dev.subscription.keys })).status).toBe(422);
    expect((await h.call('juan', 'DELETE', '/api/me/push', { endpoint: dev.subscription.endpoint })).status).toBe(200);
    expect((await h.call('juan', 'GET', '/api/me/push')).body.devices).toHaveLength(0);
  });

  it('pushes a new notification to the recipient’s device, encrypted and signed', async () => {
    const maria = fakeDevice('https://push.example.test/maria-phone');
    await h.call('manager', 'PUT', '/api/me/push', maria.subscription);
    const res = await h.call('juan', 'POST', '/api/leave', { leave_type_id: vacation, start_date: day(5), end_date: day(5), reason: 'Family event' });
    expect(res.status).toBe(201);
    expect(await h.services.push.runDue()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://push.example.test/maria-phone');
    expect(sent[0]!.headers['Content-Encoding']).toBe('aes128gcm');
    expect(sent[0]!.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    const msg = maria.decrypt(sent[0]!.body);
    expect(msg.title).toBe('Leave request: Juan Dela Cruz');
    expect(msg.kind).toBe('leave_requested');
    // Nothing is sent twice.
    expect(await h.services.push.runDue()).toBe(0);
  });

  it('sends a test alert only to the person asking, and forgets devices the push service has dropped', async () => {
    expect((await h.call('juan', 'POST', '/api/me/push/test')).status).toBe(422);
    const juan = fakeDevice('https://push.example.test/juan-laptop');
    await h.call('juan', 'PUT', '/api/me/push', juan.subscription);
    expect((await h.call('juan', 'POST', '/api/me/push/test')).status).toBe(200);
    status = 410;
    await h.services.push.runDue();
    expect(sent.map((s) => s.url)).toEqual(['https://push.example.test/juan-laptop']);
    expect(juan.decrypt(sent[0]!.body).title).toBe('Alerts are on');
    expect((await h.call('juan', 'GET', '/api/me/push')).body.devices).toHaveLength(0);
    // The test alert is in-app only: no email was queued for it.
    const emails = await h.sql(`select 1 from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.kind = 'push_test'`);
    expect(emails).toHaveLength(0);
  });

  it('retries when the push service is busy', async () => {
    const maria = fakeDevice('https://push.example.test/maria-phone');
    await h.call('manager', 'PUT', '/api/me/push', maria.subscription);
    await h.sql(`select app.notify($1, 'test_retry', 'Retry me', '', '/', 'retry-1')`, [h.ids.manager]);
    status = 503;
    expect(await h.services.push.runDue()).toBe(0);
    expect(await h.sql('select 1 from internal.push_queue')).toHaveLength(1);
    await h.sql('update internal.push_queue set next_attempt_at = now()');
    status = 201;
    expect(await h.services.push.runDue()).toBe(1);
    expect(await h.sql('select 1 from internal.push_queue')).toHaveLength(0);
  });
});
