export const ROLES = ['employee', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const REPORT_STATUSES = [
  'draft',
  'submitted',
  'processing',
  'pending_review',
  'revision_requested',
  'approved',
  'rejected',
  'delivered',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  processing: 'Processing',
  pending_review: 'Pending Review',
  revision_requested: 'Revision Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  delivered: 'Delivered',
};

export const ISSUE_STATUSES = [
  'reported',
  'pending_verification',
  'open',
  'in_progress',
  'resolution_submitted',
  'resolved',
  'closed',
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  reported: 'Reported',
  pending_verification: 'Pending Verification',
  open: 'Open',
  in_progress: 'In Progress',
  resolution_submitted: 'Resolution Submitted',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Statuses that keep an issue on the incoming shift's list. */
export const ACTIVE_ISSUE_STATUSES: readonly IssueStatus[] = [
  'reported',
  'pending_verification',
  'open',
  'in_progress',
  'resolution_submitted',
];

type Actor = 'employee' | 'manager';

/**
 * Mirror of the transition table enforced by app.transition_issue() in the database.
 * The UI uses it to decide which buttons to show; the database is authoritative.
 */
export const ISSUE_TRANSITIONS: Record<IssueStatus, Partial<Record<IssueStatus, readonly Actor[]>>> = {
  reported: { pending_verification: ['manager'], open: ['manager'], closed: ['manager'] },
  pending_verification: { open: ['manager'], closed: ['manager'] },
  open: { in_progress: ['employee', 'manager'], resolution_submitted: ['employee', 'manager'], closed: ['manager'] },
  in_progress: { open: ['employee', 'manager'], resolution_submitted: ['employee', 'manager'] },
  resolution_submitted: { resolved: ['manager'], in_progress: ['manager'] },
  resolved: { closed: ['manager'], open: ['manager'] },
  closed: { open: ['manager'] },
};

export function allowedIssueTransitions(from: IssueStatus, role: Role): IssueStatus[] {
  if (role === 'admin') return [];
  const actor: Actor = role === 'manager' ? 'manager' : 'employee';
  return (Object.entries(ISSUE_TRANSITIONS[from]) as [IssueStatus, readonly Actor[]][])
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const AUTOMATION_EVENT_STATUSES = ['pending', 'dispatched', 'completed', 'failed', 'dead'] as const;
export type AutomationEventStatus = (typeof AUTOMATION_EVENT_STATUSES)[number];

export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'simulated', 'skipped'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const RECORD_TYPES = ['maintenance', 'inventory', 'dispatch', 'policy'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const DECISIONS = ['approved', 'rejected', 'revision_requested'] as const;
export type Decision = (typeof DECISIONS)[number];
