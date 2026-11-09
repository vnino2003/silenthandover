import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Rotating attendance codes. A station shows a QR code (and the same 6 digits) that changes every
 * 30 seconds. Each code is an HMAC of the station id and the time window with the station's
 * secret, so it can't be predicted, and an old photo of it stops working within a minute.
 */
export const WINDOW_MS = 30_000;

export const newStationSecret = () => randomBytes(32).toString('base64url');

export const windowAt = (ms: number) => Math.floor(ms / WINDOW_MS);

export function codeFor(secret: string, stationId: string, window: number): string {
  const mac = createHmac('sha256', secret).update(`${stationId}:${window}`).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** What the QR encodes. The app reads the station and the code from it. */
export const qrPayload = (stationId: string, code: string) => `SHQR1:${stationId}:${code}`;

/** Accepts the current window and the one before (a scan right at the change still works). */
export function codeIsValid(secret: string, stationId: string, code: string, now = Date.now()): boolean {
  const w = windowAt(now);
  return [w, w - 1].some((x) => safeEqual(codeFor(secret, stationId, x), code));
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Device batches are signed: HMAC-SHA256(secret, `${timestamp}.${body}`), hex. */
export const deviceSignature = (secret: string, timestamp: string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
