import { z } from 'zod';
import { ISSUE_SEVERITIES } from './statuses';

/** The handover content a manager approves. This, not the AI draft, is what incoming staff receive. */
export const ApprovedIssue = z.strictObject({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(1000),
  severity: z.enum(ISSUE_SEVERITIES),
  is_safety_concern: z.boolean(),
  /** Existing issue this item updates. Null creates a new issue. Chosen by the manager, never merged automatically. */
  link_issue_id: z.uuid().nullable(),
  /** For new issues: confirmed problems open as "open"; claims the manager could not confirm open as "pending_verification". */
  initial_status: z.enum(['open', 'pending_verification']),
});
export type ApprovedIssue = z.infer<typeof ApprovedIssue>;

export const ApprovedHandover = z.strictObject({
  summary: z.string().trim().min(10).max(2000),
  completed_tasks: z.array(z.strictObject({ description: z.string().trim().min(1).max(500) })).max(50),
  unresolved_issues: z.array(ApprovedIssue).max(50),
  pending_actions: z.array(z.strictObject({ description: z.string().trim().min(1).max(500) })).max(50),
  notes_for_incoming: z.string().trim().max(2000),
});
export type ApprovedHandover = z.infer<typeof ApprovedHandover>;

export const FlagResolution = z.strictObject({
  flag_index: z.number().int().min(0),
  resolution: z.enum(['corrected', 'confirmed_with_source', 'removed_claim', 'accepted_as_unverified']),
  note: z.string().trim().max(500),
});
export type FlagResolution = z.infer<typeof FlagResolution>;

export const FLAG_RESOLUTION_LABELS: Record<FlagResolution['resolution'], string> = {
  corrected: 'Corrected in summary',
  confirmed_with_source: 'Confirmed against source record',
  removed_claim: 'Claim removed',
  accepted_as_unverified: 'Kept, marked unverified',
};

export const ReviewDecision = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('approved'),
    content: ApprovedHandover,
    flag_resolutions: z.array(FlagResolution).max(100),
    note: z.string().trim().max(1000).default(''),
  }),
  z.strictObject({
    decision: z.literal('revision_requested'),
    note: z.string().trim().min(5, 'Tell the employee what to change').max(1000),
  }),
  z.strictObject({
    decision: z.literal('rejected'),
    note: z.string().trim().min(5, 'Give a reason for rejecting').max(1000),
  }),
]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;
