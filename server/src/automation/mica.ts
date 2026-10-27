import { z } from 'zod';
import { renderMicaSystem, renderMicaUser, type MicaFactGroup, type MicaPromptKind, type OrganizationRules } from '@sh/shared';
import { callWithFallback, ProviderError, type AiSettings } from './ai-provider';
import { detectInjection } from './injection';
import { containsContactDetails, reidentify, sanitize, type RosterEntry } from './sanitize';

/**
 * Mica's AI answers in the Ask panel, with the same safeguards as the report analysis: the
 * question is sanitized, the prompt is the six-element blueprint with every block in its own tag,
 * the reply is schema-checked and then checked for invented numbers, contact details and claimed
 * actions. Records are never sent (see mica-prompt.ts); the app shows them itself. Any failure
 * falls back to the page guide, so the user can always continue. Nothing here can change a record.
 */

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export const NOTICES = {
  injection: 'Embedded instructions cannot change permissions or skip review. Mica answered from the page guide instead.',
  unavailable: "Mica's AI is unavailable right now (busy, not responding, or not connected). Your page guide and authorized records are still available.",
  unchecked: "Mica's AI answer did not pass the safety checks, so the page guide is shown instead.",
} as const;

const ACTION_CLAIM =
  /\b(i|mica)\s+(have\s+|has\s+|just\s+|already\s+)?(approved|submitted|rejected|declined|created|assigned|unassigned|removed|cancell?ed|filed|sent|deleted|updated|changed|scheduled|booked)\b/i;
const NUMBER = /\d+(?:[.,]\d+)?/g;
const norm = (n: string) => String(Number(n.replace(',', '.')));

/** Every number a reply may use: those in the material, plus 12-hour forms of the times in it. */
export function allowedNumbers(...texts: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const t of texts) {
    for (const n of t.match(NUMBER) ?? []) allowed.add(norm(n));
    for (const [, h] of t.matchAll(/\b(\d{1,2}):\d{2}\b/g)) allowed.add(String(Number(h) % 12 || 12));
  }
  return allowed;
}

/** Why a reply can't be shown, or null when it passes. */
export function checkReply(reply: string, allowed: Set<string>): string | null {
  if (containsContactDetails(reply) || /https?:\/\//i.test(reply)) return 'contact_or_link';
  if (ACTION_CLAIM.test(reply)) return 'claims_action';
  // List markers ("1. ...") are formatting, not facts.
  const body = reply.replace(/^\s*\d+[.)]\s/gm, '');
  for (const n of body.match(NUMBER) ?? []) if (!allowed.has(norm(n))) return 'unsupported_number';
  return null;
}

/** For a preparation: no contact details or links, and no number the employee didn't write. */
export function safePreparationOutput(text: string, source: string) {
  if (containsContactDetails(text) || /https?:\/\//i.test(text)) return false;
  const numbers = new Set(source.match(/\d+(?:[.,:]\d+)*/g) ?? []);
  return (text.match(/\d+(?:[.,:]\d+)*/g) ?? []).every((n) => numbers.has(n));
}

/** The engine label of an answer the app wrote itself. */
export const plainEngine = (facts: MicaFactGroup[]) => (facts.some((g) => g.items.length) ? 'records' : 'guide');

const SEP = '\n␞\n';
/** Sanitizes several texts in one pass, so each person gets the same pseudonym in all of them. */
export function sanitizeTogether(texts: string[], roster: RosterEntry[]) {
  const s = sanitize(texts.join(SEP), roster);
  return { parts: s.text.split(SEP), mapping: s.nameMapping, counts: s.counts };
}

export const stripFences = (text: string) => text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
const Reply = z.strictObject({ reply: z.string().trim().min(1).max(2400) });

export interface AskInput {
  kind: Exclude<MicaPromptKind, 'prepare'>;
  page: string;
  guide: string;
  question: string;
  roster: RosterEntry[];
  /** The administrator's organization rules, added to elements 3 and 5. */
  orgRules?: OrganizationRules | null;
}

export async function askMica(
  settings: AiSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  input: AskInput,
  log: Logger = () => {},
): Promise<{ reply: string; engine: string; fallback: boolean; notices: string[] }> {
  const guide = (fallback: boolean, notice?: string) => ({ reply: input.guide, engine: 'guide', fallback, notices: notice ? [notice] : [] });
  // A message that tries to steer the model is not sent at all.
  if (detectInjection(input.question).length) return guide(false, NOTICES.injection);

  let active: Awaited<ReturnType<AiSettings['active']>>;
  try {
    active = await settings.active();
  } catch {
    return guide(true, NOTICES.unavailable);
  }
  if (!active) return guide(false);

  const safe = sanitize(input.question, input.roster);
  try {
    const answer = await callWithFallback(
      settings,
      fetchImpl,
      { provider: active.provider, apiKey: active.apiKey, model: active.automatic ? null : active.model },
      {
        system: renderMicaSystem(input.kind, input.orgRules),
        user: renderMicaUser({ role: input.kind, page: input.page, guide: input.guide, rawInput: safe.text }),
        responseSchema: z.toJSONSchema(Reply),
      },
      Math.min(timeoutMs, 30_000),
      // Someone is waiting for this answer: give up after 45 s and show the page guide.
      45_000,
    );
    const parsed = Reply.safeParse(JSON.parse(stripFences(answer.text)));
    const reason = parsed.success ? checkReply(parsed.data.reply, allowedNumbers(safe.text, input.guide)) : 'schema';
    if (!parsed.success || reason) {
      log('mica answer rejected', { reason, page: input.page });
      return guide(true, NOTICES.unchecked);
    }
    return { reply: reidentify(parsed.data.reply, safe.nameMapping), engine: active.provider, fallback: false, notices: [] };
  } catch (err) {
    // Never log the question or the provider's body: either can contain personal data.
    log('mica provider failed', {
      page: input.page,
      status: err instanceof ProviderError ? err.status : null,
      timed_out: err instanceof ProviderError ? err.timedOut : false,
      kind: err instanceof SyntaxError ? 'not_json' : 'provider',
    });
    return guide(true, err instanceof SyntaxError ? NOTICES.unchecked : NOTICES.unavailable);
  }
}

/**
 * Puts a sanitized round trip back together for the person who wrote it: text the model returned
 * unchanged gets the original back (so a phone number or name the user typed earlier is not lost),
 * and pseudonyms in new text become the names again. Redaction markers in new text stay redacted.
 */
export function restoreDeep<T>(next: T, before: unknown, beforeSanitized: unknown, mapping: Record<string, string>): T {
  if (typeof next === 'string') {
    return (typeof before === 'string' && next === beforeSanitized ? before : reidentify(next, mapping)) as T;
  }
  if (Array.isArray(next)) {
    return next.map((v, i) => restoreDeep(v, Array.isArray(before) ? before[i] : undefined, Array.isArray(beforeSanitized) ? beforeSanitized[i] : undefined, mapping)) as T;
  }
  if (next && typeof next === 'object') {
    const b = (before ?? {}) as Record<string, unknown>;
    const bs = (beforeSanitized ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restoreDeep(v, b[k], bs[k], mapping)])) as T;
  }
  return next;
}

export const REDACTED = /\[(MEDICAL|PHONE|EMAIL|GOV-ID)-REDACTED\]/;
export const REDACTION_NOTICE =
  'Mica removed health details, contact numbers or ID numbers before sending your message to the AI. They are not in the draft; keep them out of shift reports, or add them yourself only if the report really needs them.';
