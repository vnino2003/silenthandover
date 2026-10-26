import type {
  AiHandoverDraft,
  ApprovedHandover,
  IssueSeverity,
  IssueStatus,
  ReportDraftContent,
  ReportStatus,
  Role,
  ServerFlag,
} from '@sh/shared';

export interface AppConfig {
  mode: 'local' | 'supabase';
  auth: { provider: 'local' } | { provider: 'supabase'; supabase_url: string; supabase_anon_key: string };
  demo: { password: string; accounts: { email: string; role: string; full_name: string; department: string | null }[] } | null;
  integrations: {
    ai: { adapter: 'dev' | 'n8n'; simulated: boolean; prompt_version: string };
    email: { transport: 'dev' | 'resend' | 'n8n'; simulated: boolean };
    sms: { connected: boolean; transport: 'none' | 'n8n' };
  };
}

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: Role;
  department_id: string | null;
  department_name: string | null;
  department_timezone: string | null;
  team_name: string | null;
  pseudonym: string;
  notify_email: boolean;
  notify_sms: boolean;
  server_now: string;
}

export type WindowStateValue = 'not_found' | 'not_assigned' | 'cancelled' | 'not_started' | 'early_draft' | 'open' | 'override' | 'closed';

export interface ShiftView {
  id: string;
  label: string;
  shift_date: string;
  timezone: string;
  status: string;
  starts_at: string;
  ends_at: string;
  window_opens_at: string;
  window_closes_at: string;
  allow_early_draft: boolean;
  department_name: string;
  team_name: string | null;
  supervisor_name: string | null;
  window_state?: WindowStateValue;
  override_expires_at?: string | null;
  report_id?: string | null;
  report_status?: ReportStatus | null;
  reference_code?: string | null;
}

export interface IssueRow {
  id: string;
  code: string;
  kind?: 'problem' | 'task';
  title: string;
  description?: string;
  severity: IssueSeverity;
  is_safety: boolean;
  status: IssueStatus;
  last_activity_at: string;
  created_at?: string;
  escalated_at?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  assigned_to_me?: boolean | null;
  update_count?: number;
}

export interface Decision {
  id: string;
  decision: 'approved' | 'rejected' | 'revision_requested';
  note: string;
  decided_at: string;
  revision_no: number;
  /** As stored after approval: every problem and task carries the tracked issue it became. */
  approved_content:
    | (Omit<ApprovedHandover, 'unresolved_issues' | 'pending_actions'> & {
        unresolved_issues: (ApprovedHandover['unresolved_issues'][number] & { issue_id?: string; issue_code?: string })[];
        pending_actions: (ApprovedHandover['pending_actions'][number] & { issue_id?: string; issue_code?: string })[];
      })
    | null;
  reviewer_name: string;
  flag_resolutions?: { flag_index: number; resolution: string; note: string }[];
}

export interface Revision {
  revision_no: number;
  content: ReportDraftContent;
  submitted_at: string;
  is_late: boolean;
}

export interface AnalysisRun {
  id: string;
  revision_no: number;
  attempt: number;
  status: 'succeeded' | 'invalid_output' | 'failed';
  prompt_version: string;
  engine: string;
  model: string | null;
  is_simulated: boolean;
  draft: AiHandoverDraft | null;
  flags: ServerFlag[];
  validation_errors: { path: string; message: string }[] | null;
  latency_ms: number | null;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  recipient_name: string;
  delivered_at: string;
  acknowledged_at: string | null;
  acknowledgment_note?: string | null;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}
