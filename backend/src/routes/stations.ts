import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { svc, type AppEnv, type Services } from '../http/context';
import { codeFor, deviceSignature, qrPayload, safeEqual, WINDOW_MS, windowAt } from '../services/attendance-codes';

/**
 * Endpoints used by attendance hardware rather than a signed-in person.
 *
 * GET  /api/stations/:id/code   The QR station display (a unit tablet) shows the current code.
 *      It proves itself with its station key (header X-Station-Key), never a staff account.
 * POST /api/devices/:id/events  A registered terminal or gateway (e.g. a future fingerprint or face
 *      terminal) sends punches it captured, possibly after being offline. The body is signed:
 *      X-Device-Timestamp (ms) and X-Device-Signature = hex HMAC-SHA256(key, `${timestamp}.${body}`).
 *      Matching happens at the terminal; only "staff number X, in/out, at time T" arrives here.
 */
const DeviceBatch = z.strictObject({
  events: z
    .array(z.strictObject({ event_key: z.string().min(8).max(120), staff_ref: z.string().min(1).max(64), kind: z.enum(['in', 'out']), captured_at: z.iso.datetime({ offset: true }) }))
    .min(1)
    .max(500),
});

export function stationRoutes() {
  const r = new Hono<AppEnv>();

  const secretFor = async (services: Services, id: string, kind: 'qr_station' | 'device') => {
    const [row] = await services.db.asService((q) =>
      q.query<{ secret: string; name: string }>(
        `select x.secret, s.name from internal.attendance_station_secrets x join public.attendance_stations s on s.id = x.station_id
          where s.id = $1 and s.is_active and s.kind = $2`,
        [id, kind],
      ),
    );
    return row;
  };

  r.get('/stations/:id/code', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'not_found', 'Not found');
    const station = await secretFor(svc(c), id, 'qr_station');
    const key = c.req.header('x-station-key') ?? '';
    if (!station || !safeEqual(station.secret, key)) throw new ApiError(401, 'invalid_station', 'This station is not set up or its key was reset');
    await svc(c).db.asService((q) => q.query('update public.attendance_stations set last_seen_at = now() where id = $1', [id]));
    const now = Date.now();
    const w = windowAt(now);
    const code = codeFor(station.secret, id, w);
    return c.json({ station: station.name, code, qr: qrPayload(id, code), expires_in_ms: (w + 1) * WINDOW_MS - now, server_now: new Date(now).toISOString() });
  });

  r.post('/devices/:id/events', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'not_found', 'Not found');
    const station = await secretFor(svc(c), id, 'device');
    const ts = c.req.header('x-device-timestamp') ?? '';
    const sig = c.req.header('x-device-signature') ?? '';
    const raw = await c.req.text();
    if (!station || !safeEqual(deviceSignature(station.secret, ts, raw), sig)) throw new ApiError(401, 'invalid_signature', 'Signature check failed');
    // Replay protection: the signed timestamp must be recent; each event key is accepted once.
    const drift = Date.now() - Number(ts);
    if (!Number.isFinite(drift) || Math.abs(drift) > 5 * 60_000) throw new ApiError(401, 'stale_request', 'Device clock or request too old');
    let parsed: z.infer<typeof DeviceBatch>;
    try {
      parsed = DeviceBatch.parse(JSON.parse(raw));
    } catch {
      throw new ApiError(422, 'validation', 'Invalid event batch');
    }
    const results = await svc(c).db.asService(async (q) => {
      await q.query('update public.attendance_stations set clock_drift_ms = $2 where id = $1', [id, drift]);
      const out: { event_key: string; result: string }[] = [];
      for (const e of parsed.events) {
        // Punches captured more than 7 days ago or in the future are refused (clock problems).
        const age = Date.now() - Date.parse(e.captured_at);
        if (age < -5 * 60_000 || age > 7 * 86_400_000) {
          out.push({ event_key: e.event_key, result: 'time_out_of_range' });
          continue;
        }
        const [row] = await q.query<{ r: string }>('select internal.record_device_punch($1, $2, $3, $4, $5) as r', [id, e.staff_ref, e.kind, e.captured_at, e.event_key]);
        out.push({ event_key: e.event_key, result: row!.r });
      }
      const [dept] = await q.query<{ department_id: string }>('select department_id from public.attendance_stations where id = $1', [id]);
      await q.query(`select internal.reconcile_department($1, (now() at time zone 'UTC')::date - 7, (now() at time zone 'UTC')::date + 1)`, [dept!.department_id]);
      return out;
    });
    return c.json({ results });
  });

  return r;
}
