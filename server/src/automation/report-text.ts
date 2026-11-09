import { fillTemplate, problemLine, type FilledTemplate, type ReportDraftContent } from '@sh/shared';

export const SECTION_HEADERS = {
  completed_work: 'TASKS COMPLETED',
  unresolved_issues: 'UNRESOLVED CONCERNS',
  pending_tasks: 'PENDING TASKS',
  operational_concerns: 'UNIT CONCERNS',
  handover_notes: 'ENDORSEMENT NOTES',
  evidence_refs: 'REFERENCE NUMBERS',
  issue_updates: 'UPDATES ON EARLIER CONCERNS',
} as const;

/**
 * How a submitted shift endorsement is laid out for the AI. Every core section is always present: a field
 * the staff member left blank becomes "(none stated)", so the model is told plainly that nothing was
 * said instead of guessing. Evidence references and updates on existing issues are added after
 * these sections only when the employee filled them in.
 */
export const REPORT_TEMPLATE = [
  `${SECTION_HEADERS.completed_work}:\n{{completed_work | "(none stated)"}}`,
  `${SECTION_HEADERS.unresolved_issues}:\n{{unresolved_issues | "(none stated)"}}`,
  `${SECTION_HEADERS.pending_tasks}:\n{{pending_tasks | "(none stated)"}}`,
  `${SECTION_HEADERS.operational_concerns}:\n{{operational_concerns | "(none stated)"}}`,
  `${SECTION_HEADERS.handover_notes}:\n{{handover_notes | "(none stated)"}}`,
].join('\n\n');

export interface IssueRef {
  id: string;
  code: string;
  title: string;
}

/** Fills the report template, showing which fields used their fallback. */
export function fillReportTemplate(content: ReportDraftContent, issues: IssueRef[]): FilledTemplate {
  const byId = new Map(issues.map((i) => [i.id, i]));
  // Each listed problem is its own line, so it is also its own item for the AI and the simulator.
  const problems = [...(content.problems ?? []).map(problemLine), content.unresolved_issues.trim()].filter(Boolean).join('\n');
  const filled = fillTemplate(REPORT_TEMPLATE, {
    completed_work: content.completed_work.trim(),
    unresolved_issues: (content.no_unresolved_issues ? 'Staff confirmed: no unresolved concerns.' : problems).trim(),
    pending_tasks: (content.no_pending_tasks ? 'Staff confirmed: no pending tasks.' : content.pending_tasks).trim(),
    operational_concerns: content.operational_concerns.trim(),
    handover_notes: content.handover_notes.trim(),
  });
  const extra: string[] = [];
  if (content.evidence_refs.trim()) extra.push(`${SECTION_HEADERS.evidence_refs}:\n${content.evidence_refs.trim()}`);
  if (content.issue_updates.length) {
    extra.push(
      `${SECTION_HEADERS.issue_updates}:\n` +
        content.issue_updates
          .map((u) => {
            const issue = byId.get(u.issue_id);
            const label = issue ? `${issue.code} (${issue.title})` : 'Unknown concern';
            return `- ${label}: staff member reports ${u.claimed_status.replace('_', ' ')} — ${u.note}`;
          })
          .join('\n')
          .trim(),
    );
  }
  return { text: [filled.text, ...extra].join('\n\n'), fields: filled.fields };
}

/** Flattens a structured submission into the text the AI (or the simulator) reads. */
export function renderReportText(content: ReportDraftContent, issues: IssueRef[]): string {
  return fillReportTemplate(content, issues).text;
}
