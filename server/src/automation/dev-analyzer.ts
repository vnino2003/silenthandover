import type { AiHandoverDraft, IssueSeverity } from '@sh/shared';
import { SECTION_HEADERS } from './report-text';

/**
 * DEVELOPMENT SIMULATOR — NOT AI.
 *
 * Produces a schema-valid draft from the sanitized report text with simple, deterministic
 * rules so the full workflow can be exercised before n8n and a model provider are connected.
 * Runs are stored with engine = "dev-simulator" and is_simulated = true, and the UI labels them.
 */

const SAFETY = /\b(brake|steering|leak|leaking|smoke|smell of (gas|smoke)|gas|fire|spark|sparking|electrical|exposed wire|injur|slip|spill|chemical|fume|overheat|short circuit|collapse|hazard|unsafe|danger|blocked (fire )?exit)\w*/i;
const HIGH = /\b(broken|down|not working|failed|failure|stopped|jam|jammed|urgent|critical|sira|walang|delay)\w*/i;
const REPAIR = /\b(fixed|repaired|replaced|restored|resolved|okay na|ok na|ayos na|working (again|now))\b/i;
const IN_PROGRESS = /\b(ongoing|in progress|started|partially|half|pending parts|waiting for)\b/i;
const ISSUE_CODE = /\bISS-\d{6}\b/;
const STOPWORDS = new Set(['the', 'and', 'still', 'near', 'with', 'from', 'that', 'this', 'was', 'has', 'not', 'for', 'sa', 'pero', 'kasi']);

export interface OpenIssueRef {
  code: string;
  title: string;
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );

/** Suggests an existing issue when two or more distinctive words overlap. A suggestion only; a reviewer confirms it. */
function suggestIssue(text: string, open: OpenIssueRef[]): string | null {
  const explicit = text.match(ISSUE_CODE)?.[0];
  if (explicit) return explicit;
  const words = tokens(text);
  let best: { code: string; score: number } | null = null;
  for (const issue of open) {
    const score = [...tokens(issue.title)].filter((w) => words.has(w)).length;
    if (score >= 2 && (!best || score > best.score)) best = { code: issue.code, score };
  }
  return best?.code ?? null;
}

/** A short title: the first clause of the sentence. */
function titleOf(s: string): string {
  const first = s.split(/,\s|;\s|\s[-–—]\s|\.\s|\s(?:pero|but|so)\s/)[0]!.replace(/[.!]+$/, '').trim();
  return clip(first.length >= 12 ? first : s.replace(/[.!]+$/, ''), 90);
}

function section(text: string, header: string): string {
  const headers = Object.values(SECTION_HEADERS).map((h) => `${h}:`);
  const start = text.indexOf(`${header}:`);
  if (start < 0) return '';
  const after = start + header.length + 1;
  const next = headers
    .map((h) => text.indexOf(h, after))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  const body = text.slice(after, next ?? text.length).trim();
  if (/^\(none stated\)$/.test(body) || /^Employee confirmed: no /.test(body)) return '';
  return body;
}

/** Splits free text into items on line breaks, bullets and sentence ends. Items stay verbatim substrings. */
function items(body: string): string[] {
  return body
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9[])|;\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 4);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function severityOf(s: string): IssueSeverity {
  if (SAFETY.test(s)) return 'high';
  if (HIGH.test(s)) return 'medium';
  return 'low';
}

export function simulateAnalysis(reportRef: string, text: string, openIssues: OpenIssueRef[] = []): AiHandoverDraft {
  const completed = items(section(text, SECTION_HEADERS.completed_work));
  const unresolved = items(section(text, SECTION_HEADERS.unresolved_issues));
  const concerns = items(section(text, SECTION_HEADERS.operational_concerns));
  const pending = items(section(text, SECTION_HEADERS.pending_tasks));
  const notes = section(text, SECTION_HEADERS.handover_notes);

  const draft: AiHandoverDraft = {
    report_id: reportRef,
    summary: '',
    completed_tasks: completed.map((c) => ({
      description: clip(c, 500),
      source_evidence: clip(c, 600),
      reported_status: IN_PROGRESS.test(c) ? 'partially_completed' : 'completed',
      verification_status: REPAIR.test(c) ? 'requires_verification' : 'reported_unverified',
      recommended_next_action: REPAIR.test(c) ? 'Confirm the repair against a maintenance record.' : null,
    })),
    unresolved_issues: [...unresolved, ...concerns.filter((c) => SAFETY.test(c) || HIGH.test(c))].map((u) => {
      const safety = SAFETY.test(u);
      const code = suggestIssue(u, openIssues);
      return {
        title: titleOf(u),
        description: clip(u, 1000),
        severity: severityOf(u),
        is_safety_concern: safety,
        source_evidence: clip(u, 600),
        reported_status: REPAIR.test(u) ? 'reported_addressed' : IN_PROGRESS.test(u) ? 'in_progress' : 'open',
        verification_status: safety || REPAIR.test(u) ? 'requires_verification' : 'reported_unverified',
        related_issue_code: code,
        recommended_next_action: safety
          ? 'Inspect and control the hazard before normal operation resumes.'
          : 'Incoming shift to check status and update the issue.',
      };
    }),
    pending_actions: pending.map((p) => ({
      description: clip(p, 500),
      source_evidence: clip(p, 600),
      suggested_owner: 'unspecified',
      reported_status: IN_PROGRESS.test(p) ? 'in_progress' : 'pending',
      verification_status: 'reported_unverified',
      recommended_next_action: 'Assign an owner on the incoming shift.',
    })),
    missing_information: [],
    verification_flags: [],
    suggested_follow_up: [],
    requires_human_review: true,
  };

  for (const issue of draft.unresolved_issues) {
    if (!/\d|line|bay|area|room|unit|station|dock|floor|aisle|ward|zone|#/i.test(issue.description)) {
      draft.missing_information.push({
        topic: 'Location or equipment not specified',
        detail: `"${clip(issue.title, 80)}" does not say where it is or which equipment is affected.`,
        related_evidence: issue.source_evidence,
      });
    }
  }
  if (!completed.length) {
    draft.missing_information.push({ topic: 'Completed work', detail: 'No completed work was described.', related_evidence: null });
  }
  if (notes) draft.suggested_follow_up.push('Read the handover notes with the incoming shift at turnover.');
  if (draft.unresolved_issues.some((i) => i.is_safety_concern)) {
    draft.suggested_follow_up.push('Brief the incoming shift on open safety concerns before work starts.');
  }

  const safetyCount = draft.unresolved_issues.filter((i) => i.is_safety_concern).length;
  draft.summary = [
    `[Simulated draft — development mode, no AI was called.]`,
    `${draft.completed_tasks.length} completed item(s), ${draft.unresolved_issues.length} unresolved issue(s)` +
      (safetyCount ? ` including ${safetyCount} possible safety concern(s)` : '') +
      `, and ${draft.pending_actions.length} pending action(s) reported.`,
    draft.missing_information.length ? `${draft.missing_information.length} item(s) need more detail.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return draft;
}
