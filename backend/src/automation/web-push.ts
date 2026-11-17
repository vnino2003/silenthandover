import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { Config } from '../config';
import type { Db } from '../db/types';
import type { SecretBox } from '../security/secrets';

/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292), using
 * node:crypto only. Every in-app notification is queued for the recipient's devices by a database
 * trigger; this sender delivers the queue. The push service (Google, Mozilla, Apple) only sees
 * ciphertext; the device decrypts it and shows the title and short text.
 */

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. Given to browsers as applicationServerKey. */
  publicKey: string;
  /** P-256 private scalar (32 bytes), base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Encrypts a payload for one subscription (RFC 8291, single aes128gcm record). */
export function encryptPayload(payload: Buffer, uaPublicB64: string, authSecretB64: string, opts: { salt?: Buffer; serverKeys?: ReturnType<typeof createECDH> } = {}): Buffer {
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Invalid subscription key');
  if (authSecret.length !== 16) throw new Error('Invalid subscription auth secret');
  const as = opts.serverKeys ?? createECDH('prime256v1');
  if (!opts.serverKeys) as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The VAPID Authorization header value for a push service origin. */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const pub = unb64u(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const data = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

interface DueRow {
  queue_id: string;
  attempts: number;
  notification_id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const MAX_ATTEMPTS = 5;

export class PushSender {
  private keysCache: VapidKeys | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
    private readonly config: Pick<Config, 'APP_BASE_URL'>,
    private readonly fetchImpl: typeof fetch,
    private readonly log: (m: string, e?: Record<string, unknown>) => void = () => {},
  ) {}

  /** Push needs the secrets key to keep its private key encrypted. */
  get available(): boolean {
    return this.box !== null;
  }

  /** Loads the server key pair, creating it once. */
  async keys(): Promise<VapidKeys | null> {
    if (this.keysCache) return this.keysCache;
    if (!this.box) return null;
    const box = this.box;
    this.keysCache = await this.db.asService(async (q) => {
      const [row] = await q.query<{ public_key: string; private_key_ciphertext: string }>('select public_key, private_key_ciphertext from internal.web_push_keys where id');
      if (row) return { publicKey: row.public_key, privateKey: box.open(row.private_key_ciphertext) };
      const k = generateVapidKeys();
      await q.query('insert into internal.web_push_keys (id, public_key, private_key_ciphertext) values (true, $1, $2) on conflict (id) do nothing', [k.publicKey, box.seal(k.privateKey)]);
      const [saved] = await q.query<{ public_key: string; private_key_ciphertext: string }>('select public_key, private_key_ciphertext from internal.web_push_keys where id');
      return { publicKey: saved!.public_key, privateKey: box.open(saved!.private_key_ciphertext) };
    });
    return this.keysCache;
  }

  private get subject(): string {
    return /^https:\/\//.test(this.config.APP_BASE_URL) ? this.config.APP_BASE_URL : 'mailto:push@localhost';
  }

  /** Sends what is due. Returns how many messages the push services accepted. */
  async runDue(limit = 50): Promise<number> {
    const keys = await this.keys().catch((err) => {
      this.log('push keys unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!keys) return 0;
    const rows = await this.db.asService((q) =>
      q.query<DueRow>(
        `with due as (
           select id from internal.push_queue where next_attempt_at <= now() order by id limit $1 for update skip locked
         ), claimed as (
           update internal.push_queue q set attempts = q.attempts + 1,
             next_attempt_at = now() + make_interval(secs => 30 * power(2, q.attempts)::int)
           from due where q.id = due.id returning q.*
         )
         select c.id::text as queue_id, c.attempts, n.id as notification_id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at,
                s.id as subscription_id, s.endpoint, s.p256dh, s.auth
           from claimed c
           join public.notifications n on n.id = c.notification_id
           join public.push_subscriptions s on s.id = c.subscription_id`,
        [limit],
      ),
    );
    if (!rows.length) return 0;

    const done: string[] = [];
    const gone: string[] = [];
    const ok: string[] = [];
    const failedFinal: string[] = [];
    let sent = 0;
    for (const r of rows) {
      // Already read in the app, or too old to be useful: nothing to show.
      if (r.read_at || Date.now() - new Date(r.created_at).getTime() > 24 * 3600 * 1000) {
        done.push(r.queue_id);
        continue;
      }
      const payload = Buffer.from(
        JSON.stringify({ id: r.notification_id, kind: r.kind, title: r.title.slice(0, 120), body: r.body.slice(0, 240), link: r.link ?? '/notifications' }),
      );
      try {
        const res = await this.fetchImpl(r.endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidAuthorization(keys, r.endpoint, this.subject),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: 'high',
            Topic: r.notification_id.replace(/-/g, '').slice(0, 32),
          },
          body: new Uint8Array(encryptPayload(payload, r.p256dh, r.auth)),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 200 && res.status < 300) {
          sent += 1;
          done.push(r.queue_id);
          ok.push(r.subscription_id);
        } else if (res.status === 404 || res.status === 410) {
          // The device unsubscribed or the browser data was cleared.
          gone.push(r.subscription_id);
        } else if ((res.status === 429 || res.status >= 500) && r.attempts < MAX_ATTEMPTS) {
          /* retried at next_attempt_at */
        } else {
          this.log('push rejected', { status: res.status, kind: r.kind });
          done.push(r.queue_id);
          failedFinal.push(r.subscription_id);
        }
      } catch (err) {
        if (r.attempts >= MAX_ATTEMPTS) {
          done.push(r.queue_id);
          failedFinal.push(r.subscription_id);
        }
        this.log('push send failed', { error: err instanceof Error ? err.message.slice(0, 120) : String(err), attempt: r.attempts });
      }
    }
    await this.db.asService(async (q) => {
      if (done.length) await q.query('delete from internal.push_queue where id = any($1::bigint[])', [done]);
      if (gone.length) await q.query('delete from public.push_subscriptions where id = any($1::uuid[])', [gone]);
      if (ok.length) await q.query('update public.push_subscriptions set last_success_at = now(), failures = 0 where id = any($1::uuid[])', [ok]);
      if (failedFinal.length) await q.query('update public.push_subscriptions set failures = failures + 1 where id = any($1::uuid[])', [failedFinal]);
    });
    return sent;
  }
}
