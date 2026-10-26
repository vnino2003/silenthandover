import { z } from 'zod';

const longText = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);

export const IssueUpdateInput = z.strictObject({
  issue_id: z.uuid(),
  note: longText(1000),
  claimed_status: z.enum(['still_open', 'in_progress', 'addressed']),
});
export type IssueUpdateInput = z.infer<typeof IssueUpdateInput>;

/** Shape stored while a report is a draft. Everything optional so autosave never fails. */
export const ReportDraftContent = z.strictObject({
  completed_work: longText(4000).default(''),
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
  if (!v.no_unresolved_issues && v.unresolved_issues.length < 3) {
    ctx.addIssue({
      code: 'custom',
      path: ['unresolved_issues'],
      message: 'Describe the problems still open, or tick “No open problems”',
    });
  }
  if (v.no_unresolved_issues && v.unresolved_issues.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['unresolved_issues'],
      message: 'You ticked “No open problems” — clear this field or untick the box',
    });
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
  for (const [i, u] of v.issue_updates.entries()) {
    if (u.note.length < 3) {
      ctx.addIssue({ code: 'custom', path: ['issue_updates', i, 'note'], message: 'Add a short update for this issue' });
    }
  }
});

export const REPORT_SECTIONS = [
  {
    key: 'completed_work',
    label: 'Work completed',
    hint: 'Deliveries unloaded, orders picked, counts done. Include quantities and PO or reference numbers exactly as recorded.',
  },
  {
    key: 'unresolved_issues',
    label: 'Problems still open',
    hint: 'Stock that doesn’t match, damaged goods, equipment faults, hazards. Say where, what you saw, and what you did.',
  },
  {
    key: 'pending_tasks',
    label: 'For the next shift',
    hint: 'Dispatches, restocking and follow-ups the next shift must pick up.',
  },
  {
    key: 'operational_concerns',
    label: 'Equipment & safety concerns',
    hint: 'Forklifts, conveyors, scanners, spills, blocked exits — even if unconfirmed.',
  },
  {
    key: 'handover_notes',
    label: 'Other notes',
    hint: 'Anything else the next shift should know.',
  },
] as const;
