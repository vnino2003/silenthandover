import type { AiHandoverDraft, ServerFlag } from '@sh/shared';
import type { InjectionFinding } from './injection';
import { containsContactDetails } from './sanitize';

/**
 * Deterministic fact-checking of a validated draft against what the employee actually wrote
 * and the approved source records. These checks do not trust the model's own labels:
 * they downgrade unsupported "verified" claims and raise flags the reviewer must resolve.
 */

export interface GroundingRecord {
  record_type: string;
  reference_code: string;
  title: string;
}

export interface GroundingContext {
  sourceText: string;
  records: GroundingRecord[];
  openIssueCodes: string[];
  injection: InjectionFinding[];
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^\p{L}\p{N}\[\]\-.%/:]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const REPAIR_CLAIM = /\b(fixed|repaired|replaced|restored|resolved|patched|working (again|now|na)|okay na|ok na|ayos na|gumagana na)\b/i;
const NUMBER = /\b\d+(?:[.,]\d+)?\b/g;

function evidenceFound(evidence: string, source: string): boolean {
  const e = normalize(evidence);
  if (!e) return false;
  if (source.includes(e)) return true;
  // Tolerate trimmed quotes: accept when every 6-word window of a long quote appears.
  const words = e.split(' ');
  if (words.length < 8) return false;
  for (let i = 0; i + 6 <= words.length; i += 3) {
    if (!source.includes(words.slice(i, i + 6).join(' '))) return false;
  }
  return true;
}

export function groundDraft(input: AiHandoverDraft, ctx: GroundingContext): { draft: AiHandoverDraft; flags: ServerFlag[] } {
  const draft: AiHandoverDraft = structuredClone(input);
  const source = normalize(ctx.sourceText);
  const sourceNumbers = new Set((ctx.sourceText.match(NUMBER) ?? []).map((n) => n.replace(',', '.')));
  const maintenanceRefs = ctx.records
    .filter((r) => r.record_type === 'maintenance')
    .map((r) => r.reference_code.toLowerCase());
  const recordRefs = ctx.records.map((r) => r.reference_code.toLowerCase());
  const sourceTokens = new Set(ctx.sourceText.match(/\[(EMP-[A-Z0-9]{6}|PERSON-\d+)\]/g) ?? []);
  const flags: ServerFlag[] = [];
  const add = (f: Omit<ServerFlag, 'origin'> & { origin?: ServerFlag['origin'] }) =>
    flags.push({ origin: 'grounding_check', ...f });

  const mentionsRecord = (text: string, refs: string[]) => {
    const t = text.toLowerCase();
    return refs.some((r) => t.includes(r));
  };

  type Item = { text: string; evidence: string; ref: string; verification: { get: () => string; set: (v: 'reported_unverified' | 'requires_verification') => void }; repairContext: boolean };
  const items: Item[] = [];
  draft.completed_tasks.forEach((t, i) =>
    items.push({
      text: t.description,
      evidence: t.source_evidence,
      ref: `completed_tasks[${i}]`,
      verification: { get: () => t.verification_status, set: (v) => (t.verification_status = v) },
      repairContext: true,
    }),
  );
  draft.unresolved_issues.forEach((t, i) =>
    items.push({
      text: `${t.title} ${t.description}`,
      evidence: t.source_evidence,
      ref: `unresolved_issues[${i}]`,
      verification: { get: () => t.verification_status, set: (v) => (t.verification_status = v) },
      repairContext: t.reported_status === 'reported_addressed',
    }),
  );
  draft.pending_actions.forEach((t, i) =>
    items.push({
      text: t.description,
      evidence: t.source_evidence,
      ref: `pending_actions[${i}]`,
      verification: { get: () => t.verification_status, set: (v) => (t.verification_status = v) },
      repairContext: false,
    }),
  );

  for (const item of items) {
    if (!evidenceFound(item.evidence, source)) {
      add({
        type: 'unsupported_claim',
        detail: 'The quoted evidence for this item does not appear in the submitted report.',
        source_evidence: item.evidence.slice(0, 600),
        item_ref: item.ref,
      });
      if (item.verification.get() === 'supported_by_record') item.verification.set('reported_unverified');
    }
    for (const n of item.text.match(NUMBER) ?? []) {
      if (!sourceNumbers.has(n.replace(',', '.'))) {
        add({
          type: 'conflicting_quantity',
          detail: `The value "${n}" does not appear anywhere in the submitted report.`,
          source_evidence: null,
          item_ref: item.ref,
        });
        break;
      }
    }
    if (item.repairContext && (REPAIR_CLAIM.test(item.text) || REPAIR_CLAIM.test(item.evidence))) {
      if (!mentionsRecord(`${item.text} ${item.evidence}`, maintenanceRefs)) {
        add({
          type: 'unverified_repair',
          detail: 'A repair or fix is claimed but no matching maintenance record was provided. Verify before treating it as done.',
          source_evidence: item.evidence.slice(0, 600),
          item_ref: item.ref,
        });
        item.verification.set('requires_verification');
      }
    }
    if (item.verification.get() === 'supported_by_record' && !mentionsRecord(`${item.text} ${item.evidence}`, recordRefs)) {
      item.verification.set('reported_unverified');
      add({
        type: 'unsupported_claim',
        detail: 'Marked as supported by a record, but no provided record reference matches. Downgraded to unverified.',
        source_evidence: null,
        item_ref: item.ref,
      });
    }
    for (const token of `${item.text}`.match(/\[(EMP-[A-Z0-9]{6}|PERSON-\d+)\]/g) ?? []) {
      if (!sourceTokens.has(token)) {
        add({
          type: 'ambiguous_assignment',
          detail: 'The draft names a person who is not mentioned in the report.',
          source_evidence: null,
          item_ref: item.ref,
        });
        break;
      }
    }
  }

  draft.unresolved_issues.forEach((issue, i) => {
    if (issue.is_safety_concern) {
      issue.verification_status = 'requires_verification';
      if (!draft.verification_flags.some((f) => f.type === 'safety_concern' && f.source_evidence === issue.source_evidence)) {
        add({
          type: 'safety_concern',
          detail: `Safety concern: "${issue.title}". Confirm it is communicated and controlled before approval.`,
          source_evidence: issue.source_evidence,
          item_ref: `unresolved_issues[${i}]`,
        });
      }
    }
    if (issue.related_issue_code && !ctx.openIssueCodes.includes(issue.related_issue_code)) {
      add({
        type: 'unsupported_claim',
        detail: `The draft links to ${issue.related_issue_code}, which is not an active issue in this department. The link was removed.`,
        source_evidence: null,
        item_ref: `unresolved_issues[${i}]`,
      });
      issue.related_issue_code = null;
    }
  });

  for (const f of ctx.injection) {
    add({
      origin: 'injection_detector',
      type: 'possible_prompt_injection',
      detail: `The report contains text that looks like an instruction to the AI (${f.rule.replace(/_/g, ' ')}). It was treated as data.`,
      source_evidence: f.excerpt.slice(0, 600),
      item_ref: null,
    });
  }

  if (containsContactDetails(JSON.stringify(draft))) {
    add({
      origin: 'sanitizer',
      type: 'privacy_redaction',
      detail: 'The draft contained contact details. Check that no personal information is included before approving.',
      source_evidence: null,
      item_ref: null,
    });
  }

  const modelFlags: ServerFlag[] = draft.verification_flags.map((f) => ({ ...f, origin: 'model', item_ref: null }));
  const all = [...modelFlags, ...flags];
  const seen = new Set<string>();
  const deduped = all.filter((f) => {
    const key = `${f.type}|${f.item_ref ?? ''}|${f.source_evidence ?? f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Every draft requires human review, whatever the model said.
  draft.requires_human_review = true;
  return { draft, flags: deduped };
}
