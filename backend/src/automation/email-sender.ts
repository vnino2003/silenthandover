import nodemailer from 'nodemailer';
import type { Db } from '../db/types';
import type { SecretBox } from '../security/secrets';
import { createResendTransport, type DeliveryResult, type EmailTransport, type OutboundMessage } from './notifications';

export type EmailProvider = 'none' | 'gmail' | 'resend';

export const EMAIL_PROVIDERS = [
  {
    id: 'gmail',
    label: 'Gmail',
    secret_label: 'Gmail App Password',
    note: 'Free. Sends from your Gmail address (about 500 emails a day). Needs 2-Step Verification and a 16-character App Password, not your normal password.',
    secret_url: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'resend',
    label: 'Resend',
    secret_label: 'Resend API key',
    note: 'Free tier (3,000 emails a month). Until you verify a domain, it only delivers to your own Resend email address.',
    secret_url: 'https://resend.com/api-keys',
  },
] as const;

/** Builds an SMTP transport. Replaced in tests so nothing leaves the machine. */
export type SmtpFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => { sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>; verify?(): Promise<unknown> };

const defaultSmtp: SmtpFactory = (o) =>
  nodemailer.createTransport({ ...o, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });

interface Saved {
  provider: 'gmail' | 'resend';
  fromName: string;
  fromAddress: string;
  secret: string;
}

export interface EmailSettingsView {
  provider: EmailProvider;
  from_name: string | null;
  from_address: string | null;
  has_secret: boolean;
  secret_hint: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  encryption_available: boolean;
  /** What sends email right now: the saved provider, or the server's configured fallback. */
  active: string;
  simulated: boolean;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** A plain, readable HTML version of a text email: a line that is only a link becomes a button. */
export function textToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').map((line) => {
      const t = line.trim();
      if (/^https?:\/\/\S+$/.test(t)) {
        const href = escapeHtml(t);
        return `<a href="${href}" style="display:inline-block;margin:6px 0;padding:10px 18px;border-radius:8px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600">Open link</a><br><span style="font-size:12px;color:#64748b;word-break:break-all">${href}</span>`;
      }
      return escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#0f766e">${u}</a>`);
    });
    return `<p style="margin:0 0 14px">${lines.join('<br>')}</p>`;
  });
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:560px">${paragraphs.join('')}</div>`;
}

function friendlySmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e?.code === 'EAUTH' || e?.responseCode === 535 || e?.responseCode === 534) {
    return 'Gmail rejected the sign-in. Use a 16-character App Password (not your normal Gmail password), with 2-Step Verification turned on, for this same Gmail address.';
  }
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNECTION' || e?.code === 'ESOCKET' || e?.code === 'EDNS') {
    return 'Could not reach Gmail (smtp.gmail.com:465). Check the internet connection or a firewall blocking outgoing mail.';
  }
  return (e?.message ?? 'Email could not be sent').slice(0, 300);
}

export function createGmailTransport(s: Pick<Saved, 'fromName' | 'fromAddress' | 'secret'>, smtp: SmtpFactory = defaultSmtp): EmailTransport {
  const client = smtp({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    // App Passwords are shown in groups of four; the spaces are not part of it.
    auth: { user: s.fromAddress, pass: s.secret.replace(/\s+/g, '') },
  });
  return {
    name: 'gmail',
    async send(messages) {
      const results: DeliveryResult[] = [];
      for (const m of messages) {
        try {
          const info = await client.sendMail({
            from: { name: s.fromName, address: s.fromAddress },
            to: m.to,
            subject: m.subject,
            text: m.text,
            html: m.html ?? textToHtml(m.text),
            headers: { 'X-Entity-Ref-ID': m.idempotencyKey },
          });
          results.push({ deliveryId: m.deliveryId, attempt: m.attempt, status: 'sent', provider: 'gmail', providerMessageId: info.messageId ?? null });
        } catch (err) {
          results.push({ deliveryId: m.deliveryId, attempt: m.attempt, status: 'failed', provider: 'gmail', error: friendlySmtpError(err) });
        }
      }
      return results;
    },
  };
}

/**
 * The email sender the administrator set up on the Integrations page. When none is saved, the
 * server's configured transport (the dev outbox by default) is used, so nothing changes for a
 * deployment that sets EMAIL_TRANSPORT itself.
 */
export class EmailSender {
  private saved: Saved | null = null;
  private live: EmailTransport | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
    private readonly fallback: EmailTransport,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly smtp: SmtpFactory = defaultSmtp,
  ) {}

  /** Reads the saved sender (at startup and after every save). */
  async load() {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: EmailProvider; from_name: string | null; from_address: string | null; secret_ciphertext: string | null }>(
        'select provider, from_name, from_address, secret_ciphertext from internal.email_sender_config',
      ),
    );
    this.saved = null;
    this.live = null;
    if (row && row.provider !== 'none' && row.from_address && row.secret_ciphertext && this.box) {
      try {
        this.saved = { provider: row.provider, fromName: row.from_name ?? 'Silent Handover', fromAddress: row.from_address, secret: this.box.open(row.secret_ciphertext) };
        this.live = this.build(this.saved);
      } catch {
        // A secret sealed with a different encryption key cannot be opened: fall back.
        this.saved = null;
      }
    }
  }

  private build(s: Saved): EmailTransport {
    return s.provider === 'gmail'
      ? createGmailTransport(s, this.smtp)
      : createResendTransport({ RESEND_API_KEY: s.secret, EMAIL_FROM: `${s.fromName} <${s.fromAddress}>` }, this.fetchImpl);
  }

  /** The transport the notification dispatcher uses; it always follows the latest saved settings. */
  transport(): EmailTransport {
    const self = this;
    return {
      get name() {
        return self.name;
      },
      send: (messages) => (self.live ?? self.fallback).send(messages),
    };
  }

  get name(): string {
    return this.live?.name ?? this.fallback.name;
  }

  /** True when email really leaves the machine. */
  get delivers(): boolean {
    return this.name !== 'dev';
  }

  async view(): Promise<EmailSettingsView> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: EmailProvider; from_name: string | null; from_address: string | null; has_secret: boolean; secret_hint: string | null; updated_at: string | null; updated_by_name: string | null }>(
        `select c.provider, c.from_name, c.from_address, c.secret_ciphertext is not null as has_secret, c.secret_hint,
                c.updated_at, p.full_name as updated_by_name
           from internal.email_sender_config c left join public.profiles p on p.id = c.updated_by`,
      ),
    );
    const view = row ?? { provider: 'none' as const, from_name: null, from_address: null, has_secret: false, secret_hint: null, updated_at: null, updated_by_name: null };
    return { ...view, encryption_available: Boolean(this.box), active: this.name, simulated: !this.delivers };
  }

  /** `secret`: a new one to store, `null` to remove it, `undefined` to keep the saved one. */
  async save(input: { provider: EmailProvider; fromName: string | null; fromAddress: string | null; secret?: string | null }, actorId: string) {
    if (input.secret && !this.box) throw new Error('encryption_unavailable');
    const sealed = input.secret ? this.box!.seal(input.secret) : null;
    const hint = input.secret ? input.secret.replace(/\s+/g, '').slice(-4) : null;
    await this.db.asService(async (q) => {
      await q.query(
        `update internal.email_sender_config set
            provider = $1, from_name = $2, from_address = lower($3),
            secret_ciphertext = case when $4::boolean then $5 else secret_ciphertext end,
            secret_hint = case when $4::boolean then $6 else secret_hint end,
            updated_by = $7, updated_at = now()`,
        [input.provider, input.fromName, input.fromAddress, input.secret !== undefined, sealed, hint, actorId],
      );
      // The audit records what changed, never the secret itself.
      await q.query(
        `insert into public.audit_logs (actor_id, actor_role, action, entity_type, details) values ($1, 'admin', 'email.settings_updated', 'system', $2::jsonb)`,
        [actorId, JSON.stringify({ provider: input.provider, secret: input.secret === undefined ? 'kept' : input.secret ? 'replaced' : 'removed' })],
      );
    });
    await this.load();
  }

  /** The saved secret for this provider (to test with before saving changes). */
  async savedSecret(provider: EmailProvider): Promise<string | null> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: EmailProvider; secret_ciphertext: string | null }>('select provider, secret_ciphertext from internal.email_sender_config'),
    );
    return row?.provider === provider && row.secret_ciphertext && this.box ? this.box.open(row.secret_ciphertext) : null;
  }

  /** Sends one message with the given settings, which may not be saved yet. */
  async trySend(s: Saved, to: string, subject: string, text: string): Promise<DeliveryResult> {
    const [result] = (await this.build(s).send([message(to, subject, text)])) ?? [];
    return result ?? { deliveryId: 'test', attempt: 1, status: 'failed', provider: s.provider, error: 'No result' };
  }

  /** Sends one message now with whatever is active (the dev outbox only records it). */
  async sendNow(to: string, subject: string, text: string): Promise<DeliveryResult> {
    const [result] = (await (this.live ?? this.fallback).send([message(to, subject, text)])) ?? [];
    // n8n reports later through its callback; treat the hand-off as sent.
    return result ?? { deliveryId: 'direct', attempt: 1, status: 'sent', provider: this.name };
  }
}

function message(to: string, subject: string, text: string): OutboundMessage {
  return { deliveryId: 'direct', attempt: 1, channel: 'email', to, subject, text, idempotencyKey: `direct-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}
