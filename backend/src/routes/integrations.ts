import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../http/errors';
import { parseBody, svc, type AppEnv } from '../http/context';

function secretMatches(expected: string | undefined, header: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Endpoints n8n calls back. Authenticated with N8N_CALLBACK_SECRET (Bearer). They can only
 * report results for work the API itself dispatched (event id + attempt must match); they
 * cannot approve, deliver or change any status directly.
 */
export function integrationRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    const { config } = svc(c);
    if (!config.N8N_CALLBACK_SECRET) throw new ApiError(404, 'not_found', 'Not found');
    if (!secretMatches(config.N8N_CALLBACK_SECRET, c.req.header('authorization'))) {
      throw new ApiError(401, 'unauthenticated', 'Invalid callback credentials');
    }
    await next();
  });

  r.post('/analysis-result', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        event_id: z.uuid(),
        attempt: z.number().int().min(1),
        status: z.enum(['ok', 'error']),
        output: z.unknown().optional(),
        error: z.string().max(1000).optional(),
        model: z.string().max(100).optional(),
        latency_ms: z.number().int().min(0).optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
      }),
    );
    const { analysis } = svc(c);
    if (body.status === 'error') {
      const result = await analysis.recordFailure(body.event_id, body.attempt, 'failed', `AI provider error: ${body.error ?? 'unknown'}`, {
        engine: 'n8n',
        model: body.model ?? null,
        is_simulated: false,
        latency_ms: body.latency_ms ?? null,
      });
      return c.json({ result });
    }
    const result = await analysis.complete(body.event_id, body.attempt, body.output, {
      engine: 'n8n',
      model: body.model ?? null,
      isSimulated: false,
      latencyMs: body.latency_ms ?? null,
      usage: body.usage,
    });
    return c.json({ result });
  });

  r.post('/delivery-result', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        results: z
          .array(
            z.object({
              delivery_id: z.uuid(),
              attempt: z.number().int().min(1),
              status: z.enum(['sent', 'failed']),
              provider: z.string().max(40).default('resend'),
              provider_message_id: z.string().max(200).nullable().optional(),
              response: z.unknown().optional(),
              error: z.string().max(1000).nullable().optional(),
            }),
          )
          .min(1)
          .max(100),
      }),
    );
    const results = await svc(c).notifications.recordResults(
      body.results.map((x) => ({
        deliveryId: x.delivery_id,
        attempt: x.attempt,
        status: x.status,
        provider: x.provider,
        providerMessageId: x.provider_message_id ?? null,
        response: x.response ?? null,
        error: x.error ?? null,
      })),
    );
    return c.json({ results });
  });

  r.post('/tick', async (c) => {
    const result = await svc(c).db.asService(async (q) => (await q.query<{ r: unknown }>('select internal.scheduled_tick() as r'))[0]!.r);
    svc(c).kick();
    return c.json(result);
  });

  return r;
}
