import { z } from 'zod';

const longText = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);

export const IssueUpdateInput = z.strictObject({
  issue_id: z.uuid(),
  note: longText(1000),
  claimed_status: z.enum(['still_open', 'in_progress', 'addressed']),
});
export type IssueUpdateInput = z.infer<typeof IssueUpdateInput>;

export const PROBLEM_CATEGORIES = ['stock', 'equipment', 'delivery', 'staffing', 'supplies', 'facilities', 'infection_control', 'process', 'safety', 'other'] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];
export const PROBLEM_CATEGORY_LABELS: Record<ProblemCategory, string> = {
  stock: 'Stock levels',
  equipment: 'Equipment',
  delivery: 'Transport and transfers',
  staffing: 'Staffing',
  supplies: 'Medical supplies and linen',
  facilities: 'Facilities and housekeeping',
  infection_control: 'Infection prevention and control',
  process: 'Procedures and coordination',
  safety: 'Safety concern',
  other: 'Other',
};

/** One open problem, entered as a short structured item instead of a paragraph. */
export const ProblemInput = z.strictObject({
  category: z.enum(PROBLEM_CATEGORIES),
  location: longText(120).default(''),
  what: longText(600),
});
export type ProblemInput = z.infer<typeof ProblemInput>;

/** How a structured problem reads in every organization. */
export function problemLine(p: ProblemInput): string {
  const where = p.location.trim() ? ` at ${p.location.trim()}` : '';
  return `${PROBLEM_CATEGORY_LABELS[p.category]}${where}: ${p.what.trim()}`;
}

/** Shape stored while a report is a draft. Everything optional so autosave never fails. */
export const ReportDraftContent = z.strictObject({
  completed_work: longText(4000).default(''),
  /** Open problems added one at a time. Free text below is still accepted (older reports, longer notes). */
  problems: z.array(ProblemInput).max(30).default([]),
  unresolved_issues: longText(4000).default(''),
  no_unresolved_issues: z.boolean().default(false),
  pending_tasks: longText(4000).default(''),
  no_pending_tasks: z.boolean().default(false),
  operational_concerns: longText(3000).default(''),
  handover_notes: longText(3000).default(''),
  evidence_refs: longText(500).default(''),
  issue_updates: z.array(IssueUpdateInput).max(30).default([]),
});
export type ReportDraftContent = z.infer<typeof ReportDraftContent>;

export const EMPTY_REPORT: ReportDraftContent = ReportDraftContent.parse({});

/**
 * Rules for a final submission. The employee must say explicitly when there are
 * no unresolved issues or pending tasks, so silence is never read as "all clear".
 */
export const ReportSubmission = ReportDraftContent.superRefine((v, ctx) => {
  if (v.completed_work.length < 3) {
    ctx.addIssue({ code: 'custom', path: ['completed_work'], message: 'Describe the work you completed this shift' });
  }
  const hasProblems = v.problems.length > 0 || v.unresolved_issues.length >= 3;
  if (!v.no_unresolved_issues && !hasProblems) {
    ctx.addIssue({
      code: 'custom',
      path: ['unresolved_issues'],
      message: 'Add the problems still open, or choose “No open problems”',
    });
  }
  if (v.no_unresolved_issues && (v.problems.length > 0 || v.unresolved_issues.length > 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['unresolved_issues'],
      message: 'You chose “No open problems” but also listed some — remove them or change your answer',
    });
  }
  for (const [i, p] of v.problems.entries()) {
    if (p.what.length < 3) {
      ctx.addIssue({ code: 'custom', path: ['problems', i, 'what'], message: 'Say what happened' });
    }
  }
  if (!v.no_pending_tasks && v.pending_tasks.length < 3) {
    ctx.addIssue({ code: 'custom', path: ['pending_tasks'], message: 'List what the next shift must do, or tick “Nothing for the next shift”' });
  }
  if (v.no_pending_tasks && v.pending_tasks.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['pending_tasks'],
      message: 'You ticked “Nothing for the next shift” — clear this field or untick the box',
    });
  }
  // A one-line note is only required when the worker says something was fixed.
  for (const [i, u] of v.issue_updates.entries()) {
    if (u.claimed_status === 'addressed' && u.note.length < 3) {
      ctx.addIssue({ code: 'custom', path: ['issue_updates', i, 'note'], message: 'Say what was done to fix it' });
    }
  }
});

export const REPORT_SECTIONS = [
  {
    key: 'completed_work',
    label: 'Tasks completed',
    hint: 'Rounds, checks, preparations and requests completed this shift. Include counts or reference numbers where relevant.',
  },
  {
    key: 'unresolved_issues',
    label: 'Unresolved concerns',
    hint: 'Concerns not yet resolved, such as equipment faults or missing supplies. Say where, what you observed and what you already did.',
  },
  {
    key: 'pending_tasks',
    label: 'Pending tasks',
    hint: 'Unfinished tasks and follow-ups the incoming shift needs to take over.',
  },
  {
    key: 'operational_concerns',
    label: 'Unit concerns',
    hint: 'Equipment, staffing, supplies, facilities, infection control and safety concerns, even if not yet confirmed.',
  },
  {
    key: 'handover_notes',
    label: 'Endorsement notes',
    hint: 'Anything else the incoming shift should know.',
  },
] as const;
