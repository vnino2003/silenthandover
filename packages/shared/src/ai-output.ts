import { z } from 'zod';
import { ISSUE_SEVERITIES } from './statuses';

/**
 * Element 6 of the bounded prompt: the structured output contract.
 * The server validates every model response against this schema before saving anything.
 * Every field is required (nullable where "unknown" is meaningful) so the same schema can be
 * handed to providers that enforce strict JSON-schema output.
 */

const evidence = z.string().min(1).max(600);
const nextAction = z.string().min(1).max(400);

export const VERIFICATION_STATUSES = ['reported_unverified', 'requires_verification', 'supported_by_record'] as const;
export const VerificationStatus = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  reported_unverified: 'Reported, unverified',
  requires_verification: 'Requires verification',
  supported_by_record: 'Supported by record',
};

export const FLAG_TYPES = [
  'unsupported_claim',
  'conflicting_quantity',
  'missing_evidence',
  'unverified_repair',
  'ambiguous_assignment',
  'incomplete_information',
  'possible_prompt_injection',
  'safety_concern',
  'privacy_redaction',
] as const;
export const FlagType = z.enum(FLAG_TYPES);
export type FlagType = z.infer<typeof FlagType>;

export const FLAG_LABELS: Record<FlagType, string> = {
  unsupported_claim: 'Unsupported claim',
  conflicting_quantity: 'Conflicting quantity',
  missing_evidence: 'Missing evidence',
  unverified_repair: 'Unverified repair',
  ambiguous_assignment: 'Ambiguous assignment',
  incomplete_information: 'Incomplete information',
  possible_prompt_injection: 'Possible prompt injection',
  safety_concern: 'Safety concern',
  privacy_redaction: 'Privacy redaction',
};

export const AiCompletedTask = z.strictObject({
  description: z.string().min(1).max(500),
  source_evidence: evidence,
  reported_status: z.enum(['completed', 'partially_completed']),
  verification_status: VerificationStatus,
  recommended_next_action: nextAction.nullable(),
});

export const AiUnresolvedIssue = z.strictObject({
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1000),
  severity: z.enum(ISSUE_SEVERITIES),
  is_safety_concern: z.boolean(),
  source_evidence: evidence,
  reported_status: z.enum(['open', 'in_progress', 'reported_addressed']),
  verification_status: VerificationStatus,
  related_issue_code: z
    .string()
    .regex(/^ISS-\d{6}$/)
    .nullable(),
  recommended_next_action: nextAction,
});

export const AiPendingAction = z.strictObject({
  description: z.string().min(1).max(500),
  source_evidence: evidence,
  suggested_owner: z.enum(['incoming_shift', 'supervisor', 'maintenance', 'unspecified']),
  reported_status: z.enum(['pending', 'in_progress']),
  verification_status: VerificationStatus,
  recommended_next_action: nextAction,
});

export const AiMissingInformation = z.strictObject({
  topic: z.string().min(1).max(160),
  detail: z.string().min(1).max(500),
  related_evidence: evidence.nullable(),
});

export const AiVerificationFlag = z.strictObject({
  type: FlagType,
  detail: z.string().min(1).max(500),
  source_evidence: evidence.nullable(),
});
export type AiVerificationFlag = z.infer<typeof AiVerificationFlag>;

export const AiHandoverDraft = z.strictObject({
  report_id: z.string().min(1).max(64),
  summary: z.string().min(1).max(1500),
  completed_tasks: z.array(AiCompletedTask).max(50),
  unresolved_issues: z.array(AiUnresolvedIssue).max(50),
  pending_actions: z.array(AiPendingAction).max(50),
  missing_information: z.array(AiMissingInformation).max(30),
  verification_flags: z.array(AiVerificationFlag).max(50),
  suggested_follow_up: z.array(z.string().min(1).max(300)).max(20),
  requires_human_review: z.literal(true),
});
export type AiHandoverDraft = z.infer<typeof AiHandoverDraft>;
export type AiUnresolvedIssue = z.infer<typeof AiUnresolvedIssue>;

/** Flags added by the server's deterministic checks carry an origin so reviewers can tell them apart. */
export const ServerFlag = AiVerificationFlag.extend({
  origin: z.enum(['model', 'grounding_check', 'injection_detector', 'sanitizer']),
  item_ref: z.string().nullable(),
});
export type ServerFlag = z.infer<typeof ServerFlag>;

const PROVIDER_UNSUPPORTED_KEYWORDS = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'maxItems', 'minItems']);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!PROVIDER_UNSUPPORTED_KEYWORDS.has(k)) out[k] = strip(v);
    }
    return out;
  }
  return node;
}

/**
 * JSON Schema handed to the model provider (OpenAI `response_format: json_schema, strict: true`
 * or Gemini `responseSchema`). Length limits are removed because not every provider supports
 * them; Zod still enforces them on our side.
 */
export function handoverDraftJsonSchema(): Record<string, unknown> {
  return strip(z.toJSONSchema(AiHandoverDraft, { target: 'draft-7' })) as Record<string, unknown>;
}
