import type { Db } from '../db/types';
import type { SecretBox } from '../security/secrets';

/**
 * The AI provider an administrator connects on the admin page. The API calls it directly with
 * the stored key; only the sanitized, delimited prompt is sent.
 */
export type AiProvider = 'simulator' | 'gemini' | 'grok';

/**
 * Providers retire model names over time, so none is hard-coded: when the administrator leaves
 * the model empty, the newest suitable model the key can use is looked up (see pickModel).
 */
export const AI_PROVIDERS = {
  gemini: { label: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  grok: { label: 'xAI Grok', keyUrl: 'https://console.x.ai' },
} as const;

type Provider = Exclude<AiProvider, 'simulator'>;

/** The models this key can use for text generation, newest first. */
export async function listModels(fetchImpl: typeof fetch, provider: Provider, apiKey: string, timeoutMs = 15000): Promise<string[]> {
  const url = provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' : 'https://api.x.ai/v1/models';
  const headers: Record<string, string> = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderError(`Could not reach ${label(provider)}`, null);
  }
  const body = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok) throw providerError(provider, res.status, body, apiKey);
  const names: string[] =
    provider === 'gemini'
      ? (body?.models ?? [])
          .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m: { name: string }) => String(m.name).replace(/^models\//, ''))
          .filter((n: string) => n.startsWith('gemini-') && !/embedding|image|tts|audio|live|vision|robotics|computer-use/.test(n))
      : (body?.data ?? body?.models ?? [])
          .map((m: { id: string }) => String(m.id))
          .filter((n: string) => n.startsWith('grok') && !/image|vision|imagine|video/.test(n));
  return [...new Set(names)].sort((a, b) => version(b) - version(a) || a.localeCompare(b));
}

const version = (name: string) => Number.parseFloat(/^(?:gemini|grok)-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? '0');

/**
 * The model to use when none is chosen: the newest stable, fast general model the key can use
 * (Gemini "flash", Grok "mini"), falling back to the newest model of any kind.
 */
export function pickModel(provider: Provider, models: string[]): string | null {
  return modelChoices(provider, models)[0] ?? null;
}

/**
 * The models to try, in order, when none is chosen: newest preferred (stable fast) models first,
 * then other stable ones, then lighter ones. If one is busy, the next is tried.
 */
export function modelChoices(provider: Provider, models: string[]): string[] {
  const preferred = provider === 'gemini' ? /^gemini-[\d.]+-flash(-\d+)?$/ : /^grok-[\d.]+(-fast)?-mini/;
  const unstable = /preview|exp|experimental|beta|latest|thinking/;
  const stable = models.filter((m) => !unstable.test(m));
  const main = stable.filter((m) => preferred.test(m) && !/lite/.test(m));
  const lite = stable.filter((m) => /lite/.test(m));
  const other = stable.filter((m) => !preferred.test(m) && !/lite/.test(m));
  // When the newest models are overloaded the lighter ones usually aren't, so mix them in early.
  const ordered = [...main.slice(0, 3), ...lite.slice(0, 2), ...other.slice(0, 1), ...main.slice(3)];
  return [...new Set(ordered.length ? ordered : models)].slice(0, 6);
}

/** Errors that mean "this model is busy or out of quota right now", worth trying another model for. */
export const isBusy = (err: unknown) =>
  err instanceof ProviderError && (err.timedOut || (err.status !== null && [429, 500, 502, 503, 504].includes(err.status)));

/**
 * Calls the provider. With a chosen model it calls that model only. In automatic mode it tries the
 * newest suitable model first and, if that one is busy or out of quota, the next ones in turn.
 */
export async function callWithFallback(
  settings: AiSettings,
  fetchImpl: typeof fetch,
  target: { provider: Provider; apiKey: string; model: string | null },
  prompt: ProviderPrompt,
  timeoutMs: number,
  /** Stop trying further models once this much time has passed (default: no limit). */
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<ProviderReply & { model: string; tried: string[] }> {
  const choices = target.model ? [target.model] : await settings.modelChoices(target.provider, target.apiKey);
  const tried: string[] = [];
  const started = Date.now();
  let last: unknown;
  for (const model of choices) {
    const left = budgetMs - (Date.now() - started);
    if (tried.length && left < 3000) break;
    tried.push(model);
    try {
      return { ...(await callProvider(fetchImpl, target.provider, model, target.apiKey, prompt, Math.min(timeoutMs, left))), model, tried };
    } catch (err) {
      last = err;
      if (!isBusy(err)) {
        // A retired model: look the list up again next time.
        if (!target.model && err instanceof ProviderError && err.status === 404) settings.forgetModel();
        throw err;
      }
    }
  }
  if (tried.length > 1 && last instanceof ProviderError) {
    throw new ProviderError(`${last.message} (also tried: ${tried.slice(0, -1).join(', ')})`, last.status);
  }
  throw last;
}

function providerError(provider: Provider, status: number, body: Record<string, any> | null, apiKey: string) {
  const detail = String(body?.error?.message ?? body?.error ?? '').replaceAll(apiKey, '[key]').slice(0, 240);
  // Some providers answer a bad key with 400, not 401 (xAI does), so read the message too.
  const badKey = status === 401 || status === 403 || (status === 400 && /api.?key/i.test(detail));
  const hint = badKey
    ? provider === 'grok'
      ? ' — check the API key (xAI API keys start with "xai-" and come from console.x.ai, not grok.com)'
      : ' — check the API key'
    : status === 404
      ? ' — check the model name, or leave it empty to use the newest available'
      : status === 429
        ? ' — rate limit or quota reached'
        : status >= 500
          ? ' — the provider is busy or having trouble; it is temporary, try again in a moment'
          : '';
  return new ProviderError(`${label(provider)} responded ${status}${hint}${detail ? `: ${detail}` : ''}`, status);
}

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
    /** True when the model simply didn't answer in time (an overloaded model can just hang). */
    readonly timedOut = false,
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
      throw new ProviderError(timedOut ? `${label(provider)} did not answer within ${Math.round(timeoutMs / 1000)} s` : `Could not reach ${label(provider)}`, null, timedOut);
    }
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    return { res, body };
  };

  let { res, body } = await send(true);
  // Some models reject a full JSON schema; JSON mode still works and our own validator checks the shape.
  if (res.status === 400 && /schema/i.test(String(body?.error?.message ?? ''))) ({ res, body } = await send(false));
  if (!res.ok) throw providerError(provider, res.status, body, apiKey);
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
  /** The model the administrator chose, or null for "the newest available". */
  model: string | null;
  /** When the model is automatic: the one in use right now, if it has been looked up. */
  resolved_model: string | null;
  has_key: boolean;
  key_hint: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  encryption_available: boolean;
}

const MODEL_CACHE_MS = 60 * 60 * 1000;
/** Used only when the model list can't be fetched: aliases that follow the provider's newest model. */
const FALLBACK_MODEL: Record<Provider, string> = { gemini: 'gemini-flash-latest', grok: 'grok-latest' };

/** Reads and writes the administrator's AI settings. The key is sealed before it is stored. */
export class AiSettings {
  private resolved: { provider: Provider; keyHint: string; models: string[]; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The models to try for this key in automatic mode, best first, remembered for an hour. Never
   * throws: if the list can't be fetched, the last known list or the provider's "latest" alias
   * is used, and any real problem (a wrong key, say) is reported by the call itself.
   */
  async modelChoices(provider: Provider, apiKey: string): Promise<string[]> {
    const keyHint = apiKey.slice(-6);
    const r = this.resolved;
    const known = r && r.provider === provider && r.keyHint === keyHint ? r : null;
    if (known && Date.now() - known.at < MODEL_CACHE_MS) return known.models;
    const choices = await listModels(this.fetchImpl, provider, apiKey).then(
      (models) => modelChoices(provider, models),
      () => [] as string[],
    );
    if (!choices.length) return known?.models ?? [FALLBACK_MODEL[provider]];
    this.resolved = { provider, keyHint, models: choices, at: Date.now() };
    return choices;
  }

  /** The newest suitable model for this key (the first automatic choice). */
  async resolveModel(provider: Provider, apiKey: string): Promise<string> {
    return (await this.modelChoices(provider, apiKey))[0]!;
  }

  /** The saved key, if it was saved for this provider (for testing and listing models). */
  async savedKey(provider: Provider): Promise<string | null> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: AiProvider; api_key_ciphertext: string | null }>('select provider, api_key_ciphertext from internal.ai_provider_config'),
    );
    return row?.provider === provider && row.api_key_ciphertext && this.box ? this.box.open(row.api_key_ciphertext) : null;
  }

  /** Called when a model was rejected (retired), so the next call looks it up again. */
  forgetModel() {
    this.resolved = null;
  }

  async view(): Promise<AiSettingsView> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: AiProvider; model: string | null; has_key: boolean; key_hint: string | null; updated_at: string | null; updated_by_name: string | null }>(
        `select c.provider, c.model, c.api_key_ciphertext is not null as has_key, c.api_key_hint as key_hint,
                c.updated_at, p.full_name as updated_by_name
           from internal.ai_provider_config c left join public.profiles p on p.id = c.updated_by`,
      ),
    );
    const view = row ?? { provider: 'simulator' as const, model: null, has_key: false, key_hint: null, updated_at: null, updated_by_name: null };
    const resolved = !view.model && this.resolved?.provider === view.provider ? (this.resolved.models[0] ?? null) : null;
    return { ...view, resolved_model: resolved, encryption_available: Boolean(this.box) };
  }

  /** The provider to call right now, or null when the simulator should be used. */
  async active(): Promise<{ provider: Provider; model: string; apiKey: string; automatic: boolean } | null> {
    const [row] = await this.db.asService((q) =>
      q.query<{ provider: AiProvider; model: string | null; api_key_ciphertext: string | null }>(
        'select provider, model, api_key_ciphertext from internal.ai_provider_config',
      ),
    );
    if (!row || row.provider === 'simulator' || !row.api_key_ciphertext || !this.box) return null;
    const apiKey = this.box.open(row.api_key_ciphertext);
    return { provider: row.provider, model: row.model ?? (await this.resolveModel(row.provider, apiKey)), apiKey, automatic: !row.model };
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
