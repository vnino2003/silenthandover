import type { Config } from '../config';
import type { Db } from '../db/types';

export interface OutboundMessage {
  deliveryId: string;
  attempt: number;
  channel: 'email' | 'sms';
  to: string;
  subject: string;
  text: string;
  /** Optional HTML version (built from the text when absent). */
  html?: string;
  idempotencyKey: string;
}

export interface DeliveryResult {
  deliveryId: string;
  attempt: number;
  status: 'sent' | 'failed' | 'simulated' | 'skipped';
  provider: string;
  providerMessageId?: string | null;
  response?: unknown;
  error?: string | null;
}

/** A transport either returns results now, or returns null when results arrive later via callback (n8n). */
export interface EmailTransport {
  readonly name: 'dev' | 'resend' | 'n8n' | 'gmail' | (string & {});
  send(messages: OutboundMessage[]): Promise<DeliveryResult[] | null>;
}

export interface SmsTransport {
  readonly name: 'n8n';
  send(messages: OutboundMessage[]): Promise<DeliveryResult[] | null>;
}

interface ClaimedRow {
  delivery_id: string;
  attempt: number;
  channel: 'email' | 'sms';
  address: string;
  idempotency_key: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  recipient_name: string;
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

export function maskAddress(address: string): string {
  const at = address.indexOf('@');
  if (at > 0) return `${address[0]}***${address.slice(at)}`;
  return address.length > 4 ? `***${address.slice(-4)}` : '***';
}

export class NotificationDispatcher {
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, 'APP_BASE_URL'>,
    private readonly emailTransport: EmailTransport,
    private readonly smsTransport: SmsTransport | null,
    private readonly log: (m: string, e?: Record<string, unknown>) => void = () => {},
  ) {}

  get transportName() {
    return this.emailTransport.name;
  }

  get smsTransportName() {
    return this.smsTransport?.name ?? 'none';
  }

  async runDue(limit = 25): Promise<number> {
    const { rows, templates } = await this.db.asService(async (q) => ({
      rows: await q.query<ClaimedRow>('select * from internal.claim_deliveries($1)', [limit]),
      templates: await q.query<{ key: string; subject: string; body: string }>('select key, subject, body from public.notification_templates'),
    }));
    if (!rows.length) return 0;
    const tpl = new Map(templates.map((t) => [t.key, t]));
    const fallback = tpl.get('default') ?? { key: 'default', subject: '{{title}}', body: '{{body}}\n\n{{link}}' };

    const results: DeliveryResult[] = [];
    const email: OutboundMessage[] = [];
    const sms: OutboundMessage[] = [];
    for (const r of rows) {
      if (r.channel === 'sms') {
        if (!this.smsTransport) {
          results.push({ deliveryId: r.delivery_id, attempt: r.attempt, status: 'skipped', provider: 'none', error: 'No SMS provider connected' });
        } else {
          sms.push({
            deliveryId: r.delivery_id,
            attempt: r.attempt,
            channel: 'sms',
            to: r.address,
            subject: '',
            text: `${r.title}\n${r.body}\n${this.config.APP_BASE_URL}${r.link ?? '/'}`.slice(0, 1000),
            idempotencyKey: r.idempotency_key,
          });
        }
        continue;
      }
      const t = tpl.get(r.kind) ?? fallback;
      const vars = {
        title: r.title,
        body: r.body,
        link: `${this.config.APP_BASE_URL}${r.link ?? '/'}`,
        recipient_name: r.recipient_name,
        app_name: 'Silent Handover',
      };
      email.push({
        deliveryId: r.delivery_id,
        attempt: r.attempt,
        channel: 'email',
        to: r.address,
        subject: renderTemplate(t.subject, vars).slice(0, 200),
        text: renderTemplate(t.body, vars),
        idempotencyKey: r.idempotency_key,
      });
    }
    if (email.length) {
      try {
        const sent = await this.emailTransport.send(email);
        if (sent) results.push(...sent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transport error';
        this.log('email transport failed', { error: message, count: email.length });
        for (const m of email) {
          results.push({ deliveryId: m.deliveryId, attempt: m.attempt, status: 'failed', provider: this.emailTransport.name, error: message });
        }
      }
    }
    if (sms.length && this.smsTransport) {
      try {
        const sent = await this.smsTransport.send(sms);
        if (sent) results.push(...sent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transport error';
        this.log('sms transport failed', { error: message, count: sms.length });
        for (const m of sms) {
          results.push({ deliveryId: m.deliveryId, attempt: m.attempt, status: 'failed', provider: this.smsTransport.name, error: message });
        }
      }
    }
    await this.recordResults(results);
    return rows.length;
  }

  async recordResults(results: DeliveryResult[]): Promise<string[]> {
    if (!results.length) return [];
    return this.db.asService(async (q) => {
      const out: string[] = [];
      for (const r of results) {
        const [row] = await q.query<{ result: string }>(
          'select internal.record_delivery_result($1, $2, $3, $4, $5, $6::jsonb, $7) as result',
          [r.deliveryId, r.attempt, r.status, r.provider, r.providerMessageId ?? null, JSON.stringify(r.response ?? null), r.error ?? null],
        );
        out.push(row!.result);
      }
      return out;
    });
  }
}

/** DEV OUTBOX: nothing leaves the machine. Messages are recorded as "simulated", never as "sent". */
export function createDevTransport(): EmailTransport {
  return {
    name: 'dev',
    async send(messages) {
      return messages.map((m) => ({
        deliveryId: m.deliveryId,
        attempt: m.attempt,
        status: 'simulated' as const,
        provider: 'dev-outbox',
        response: { subject: m.subject, preview: m.text.slice(0, 500), to: maskAddress(m.to) },
      }));
    },
  };
}

export function createResendTransport(config: Pick<Config, 'RESEND_API_KEY' | 'EMAIL_FROM'>, fetchImpl: typeof fetch = fetch): EmailTransport {
  return {
    name: 'resend',
    async send(messages) {
      const results: DeliveryResult[] = [];
      for (const m of messages) {
        try {
          const res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': m.idempotencyKey,
            },
            body: JSON.stringify({ from: config.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text }),
            signal: AbortSignal.timeout(10000),
          });
          const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
          results.push(
            res.ok
              ? { deliveryId: m.deliveryId, attempt: m.attempt, status: 'sent', provider: 'resend', providerMessageId: body.id ?? null, response: { id: body.id } }
              : { deliveryId: m.deliveryId, attempt: m.attempt, status: 'failed', provider: 'resend', response: { status: res.status, name: body.name }, error: `Resend ${res.status}: ${body.message ?? 'error'}` },
          );
        } catch (err) {
          results.push({ deliveryId: m.deliveryId, attempt: m.attempt, status: 'failed', provider: 'resend', error: err instanceof Error ? err.message : 'Network error' });
        }
      }
      return results;
    },
  };
}

/** Workflow B: n8n sends the email and reports each result to /api/integrations/n8n/delivery-result. */
export function createN8nTransport(config: Config, fetchImpl: typeof fetch = fetch): EmailTransport {
  return {
    name: 'n8n',
    async send(messages) {
      const res = await fetchImpl(config.N8N_DELIVERY_WEBHOOK_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Silent-Handover-Secret': config.N8N_WEBHOOK_SECRET! },
        body: JSON.stringify({
          deliveries: messages.map((m) => ({
            delivery_id: m.deliveryId,
            attempt: m.attempt,
            channel: m.channel,
            to: m.to,
            subject: m.subject,
            text: m.text,
            idempotency_key: m.idempotencyKey,
          })),
          from: config.EMAIL_FROM,
          callback_url: `${config.PUBLIC_API_URL}/api/integrations/n8n/delivery-result`,
        }),
        signal: AbortSignal.timeout(config.N8N_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      return null;
    },
  };
}

/** Optional SMS workflow. n8n owns the provider credential and reports results through the existing callback. */
export function createN8nSmsTransport(config: Config, fetchImpl: typeof fetch = fetch): SmsTransport {
  return {
    name: 'n8n',
    async send(messages) {
      const res = await fetchImpl(config.N8N_SMS_WEBHOOK_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Silent-Handover-Secret': config.N8N_WEBHOOK_SECRET! },
        body: JSON.stringify({
          deliveries: messages.map((m) => ({
            delivery_id: m.deliveryId,
            attempt: m.attempt,
            channel: m.channel,
            to: m.to,
            text: m.text,
            idempotency_key: m.idempotencyKey,
          })),
          from: config.SMS_FROM,
          callback_url: `${config.PUBLIC_API_URL}/api/integrations/n8n/delivery-result`,
        }),
        signal: AbortSignal.timeout(config.N8N_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      return null;
    },
  };
}
