import type { Db } from '../db/types';
import type { SecretBox } from '../security/secrets';

/**
 * The AI provider an administrator connects on the admin page. The API calls it directly with
 * the stored key; only the sanitized, delimited prompt is sent.
 */
export type AiProvider = 'simulator' | 'gemini' | 'grok';

export const AI_PROVIDERS = {
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  grok: { label: 'xAI Grok', defaultModel: 'grok-3-mini', keyUrl: 'https://console.x.ai' },
} as const;

export interface ProviderPrompt {
  system: string;
  user: string;
  responseSchema?: Record<string, unknown>;
}

export interface ProviderReply {
  text: string;
  usage: unknown;
  latencyMs: number;
}

/** A provider failure with a message that is safe to store and show (never contains the key). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export async function callProvider(
  fetchImpl: typeof fetch,
  provider: Exclude<AiProvider, 'simulator'>,
  model: string,
  apiKey: string,
  prompt: ProviderPrompt,
  timeoutMs: number,
): Promise<ProviderReply> {
  const started = Date.now();
  const send = async (withSchema: boolean) => {
    const request: { url: string; headers: Record<string, string>; body: unknown } =
      provider === 'gemini'
        ? {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: {
              systemInstruction: { parts: [{ text: prompt.system }] },
              contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                ...(withSchema && prompt.responseSchema ? { responseJsonSchema: prompt.responseSchema } : {}),
              },
            },
          }
        : {
            url: 'https://api.x.ai/v1/chat/completions',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: {
              model,
              temperature: 0.2,
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              response_format:
                withSchema && prompt.responseSchema
                  ? { type: 'json_schema', json_schema: { name: 'handover_draft', strict: true, schema: prompt.responseSchema } }
                  : { type: 'json_object' },
            },
          };
    let res: Response;
    try {
      res = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderError(timedOut ? `${label(provider)} did not answer within ${Math.round(timeoutMs / 1000)} s` : `Could not reach ${label(provider)}`, null);
    }
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    return { res, body };
  };

  let { res, body } = await send(true);
  // Some models reject a full JSON schema; JSON mode still works and our own validator checks the shape.
  if (res.status === 400 && /schema/i.test(String(body?.error?.message ?? ''))) ({ res, body } = await send(false));
  if (!res.ok) {
    const detail = String(body?.error?.message ?? body?.error ?? '').replaceAll(apiKey, '[key]').slice(0, 240);
    const hint = res.status === 401 || res.status === 403 ? ' — check the API key' : res.status === 404 ? ' — check the model name' : res.status === 429 ? ' — rate limit or quota reached' : '';
    throw new ProviderError(`${label(provider)} responded ${res.status}${hint}${detail ? `: ${detail}` : ''}`, res.status);
  }
  const text =
    provider === 'gemini'
      ? (body?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
      : String(body?.choices?.[0]?.message?.content ?? '');
  if (!text) {
    const reason = provider === 'gemini' ? (body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason) : body?.choices?.[0]?.finish_reason;
    throw new ProviderError(`${label(provider)} returned no text${reason ? ` (${reason})` : ''}`, res.status);
  }
  return { text, usage: provider === 'gemini' ? (body?.usageMetadata ?? null) : (body?.usage ?? null), latencyMs: Date.now() - started };
}

const label = (provider: Exclude<AiProvider, 'simulator'>) => AI_PROVIDERS[provider].label;

export interface AiSettingsView {
  provider: AiProvider;
  model: string | null;
  has_key: boolean;
  key_hint: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  encryption_available: boolean;
}

/** Reads and writes the administrator's AI settings. The key is sealed before it is stored. */
export class AiSettings {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
  ) {}

  async view(): Promise<AiSettingsView> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: AiProvider; model: string | null; has_key: boolean; key_hint: string | null; updated_at: string | null; updated_by_name: string | null }>(
        `select c.provider, c.model, c.api_key_ciphertext is not null as has_key, c.api_key_hint as key_hint,
                c.updated_at, p.full_name as updated_by_name
           from internal.ai_provider_config c left join public.profiles p on p.id = c.updated_by`,
      ),
    );
    return { ...(row ?? { provider: 'simulator', model: null, has_key: false, key_hint: null, updated_at: null, updated_by_name: null }), encryption_available: Boolean(this.box) };
  }

  /** The provider to call right now, or null when the simulator should be used. */
  async active(): Promise<{ provider: Exclude<AiProvider, 'simulator'>; model: string; apiKey: string } | null> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: AiProvider; model: string | null; api_key_ciphertext: string | null }>(
        'select provider, model, api_key_ciphertext from internal.ai_provider_config',
      ),
    );
    if (!row || row.provider === 'simulator' || !row.api_key_ciphertext || !this.box) return null;
    return { provider: row.provider, model: row.model ?? AI_PROVIDERS[row.provider].defaultModel, apiKey: this.box.open(row.api_key_ciphertext) };
  }

  /** `apiKey`: a new key to store, `null` to remove the stored one, `undefined` to keep it. */
  async save(input: { provider: AiProvider; model: string | null; apiKey?: string | null }, actorId: string) {
    if (input.apiKey && !this.box) throw new Error('encryption_unavailable');
    const sealed = input.apiKey ? this.box!.seal(input.apiKey) : null;
    const hint = input.apiKey ? input.apiKey.slice(-4) : null;
    await this.db.asService(async (q) => {
      await q.query(
        `update internal.ai_provider_config set
            provider = $1, model = $2,
            api_key_ciphertext = case when $3::boolean then $4 else api_key_ciphertext end,
            api_key_hint = case when $3::boolean then $5 else api_key_hint end,
            updated_by = $6, updated_at = now()`,
        [input.provider, input.model, input.apiKey !== undefined, sealed, hint, actorId],
      );
      // The audit records what changed, never the key itself.
      await q.query(
        `insert into public.audit_logs (actor_id, actor_role, action, entity_type, details) values ($1, 'admin', 'ai.settings_updated', 'system', $2::jsonb)`,
        [actorId, JSON.stringify({ provider: input.provider, model: input.model, key: input.apiKey === undefined ? 'kept' : input.apiKey ? 'replaced' : 'removed' })],
      );
    });
  }
}
