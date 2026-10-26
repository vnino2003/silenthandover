import { problemLine, type ReportDraftContent } from '@sh/shared';

export const SECTION_HEADERS = {
  completed_work: 'COMPLETED WORK',
  unresolved_issues: 'UNRESOLVED ISSUES',
  pending_tasks: 'PENDING TASKS',
  operational_concerns: 'OPERATIONAL CONCERNS',
  handover_notes: 'HANDOVER NOTES',
  evidence_refs: 'EVIDENCE REFERENCES',
  issue_updates: 'UPDATES ON EXISTING ISSUES',
} as const;

export interface IssueRef {
  id: string;
  code: string;
  title: string;
}

/** Flattens a structured submission into the text the AI (or the simulator) reads. */
export function renderReportText(content: ReportDraftContent, issues: IssueRef[]): string {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const parts: string[] = [];
  const add = (header: string, body: string) => parts.push(`${header}:\n${body.trim() || '(none stated)'}`);
  add(SECTION_HEADERS.completed_work, content.completed_work);
  // Each listed problem is its own line, so it is also its own item for the AI and the simulator.
  const problems = [...(content.problems ?? []).map(problemLine), content.unresolved_issues.trim()].filter(Boolean).join('\n');
  add(SECTION_HEADERS.unresolved_issues, content.no_unresolved_issues ? 'Employee confirmed: no unresolved issues.' : problems);
  add(SECTION_HEADERS.pending_tasks, content.no_pending_tasks ? 'Employee confirmed: no pending tasks.' : content.pending_tasks);
  add(SECTION_HEADERS.operational_concerns, content.operational_concerns);
  add(SECTION_HEADERS.handover_notes, content.handover_notes);
  if (content.evidence_refs.trim()) add(SECTION_HEADERS.evidence_refs, content.evidence_refs);
  if (content.issue_updates.length) {
    add(
      SECTION_HEADERS.issue_updates,
      content.issue_updates
        .map((u) => {
          const issue = byId.get(u.issue_id);
          const label = issue ? `${issue.code} (${issue.title})` : 'Unknown issue';
          return `- ${label}: employee says ${u.claimed_status.replace('_', ' ')} — ${u.note}`;
        })
        .join('\n'),
    );
  }
  return parts.join('\n\n');
}
