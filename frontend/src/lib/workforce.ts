import type { Tone } from '@/components/ui/StatusBadge.vue';

/** Attendance, DTR and payroll: shared labels and small helpers for the workforce pages. */

export interface Punch { kind: 'in' | 'out'; source: string; at: string }
export interface AttendanceRecord {
  id: string;
  shift_id: string;
  profile_id: string;
  full_name: string;
  job_title: string | null;
  shift_label: string;
  shift_date: string;
  status: 'scheduled' | 'clocked_in' | 'present' | 'incomplete' | 'no_show' | 'absent' | 'excused';
  scheduled_start: string;
  scheduled_end: string;
  time_in: string | null;
  time_out: string | null;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_candidate_minutes: number;
  overtime_approved_minutes: number;
  overtime_treatment: 'pay' | 'compensatory_time' | null;
  paid_leave_minutes: number;
  unpaid_leave_minutes: number;
  verified_at: string | null;
  locked_at: string | null;
  punches: Punch[];
}
export interface AttendanceException {
  id: string;
  kind: string;
  detail: string;
  shift_id: string | null;
  event_id: string | null;
  profile_id?: string;
  full_name?: string;
  shift_label: string | null;
  shift_date: string | null;
  record_id?: string | null;
  created_at: string;
}

/** The four states the brief keeps distinct, plus the in-between ones. */
export const RECORD_STATUS: Record<AttendanceRecord['status'], { label: string; tone: Tone }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  clocked_in: { label: 'Clocked in', tone: 'info' },
  present: { label: 'Clocked in and out', tone: 'accent' },
  incomplete: { label: 'Incomplete', tone: 'warn' },
  no_show: { label: 'No time-in', tone: 'bad' },
  absent: { label: 'Absence confirmed', tone: 'bad' },
  excused: { label: 'On leave', tone: 'violet' },
};
export const recordStatus = (r: AttendanceRecord) =>
  r.status === 'present' && r.verified_at ? { label: 'Verified present', tone: 'ok' as Tone } : RECORD_STATUS[r.status];

export const EXCEPTION_LABEL: Record<string, string> = {
  missing_in: 'Missing time-in',
  missing_out: 'Missing time-out',
  late: 'Late',
  undertime: 'Left before the end',
  overtime: 'Overtime to decide',
  possible_absence: 'No time-in (possible absence)',
  unscheduled: 'Punch with no duty',
  duplicate: 'Repeated time-in',
  pending_leave: 'Leave not decided yet',
};

export const SOURCE_LABEL: Record<string, string> = { qr: 'QR', attestation: 'Attested', correction: 'Correction', kiosk: 'Kiosk', device: 'Terminal' };

export const DTR_STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  staff_confirmed: { label: 'Confirmed by staff', tone: 'info' },
  certified: { label: 'Certified', tone: 'ok' },
  superseded: { label: 'Replaced', tone: 'neutral' },
  missing: { label: 'Not opened', tone: 'warn' },
};

export const RUN_STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Waiting for Finance', tone: 'warn' },
  returned: { label: 'Returned', tone: 'bad' },
  approved: { label: 'Approved', tone: 'info' },
  released: { label: 'Released', tone: 'ok' },
};

export const CAPABILITY_LABEL: Record<string, string> = {
  nursing_service: 'Nursing Service (Chief Nurse)',
  timekeeper: 'HR timekeeper',
  hr_admin: 'HR administrator',
  payroll_preparer: 'Payroll personnel',
  finance_approver: 'Finance approver',
};

/** 135 -> "2 h 15 min". */
export function minutes(n: number | null | undefined): string {
  const m = Math.max(0, Math.round(Number(n ?? 0)));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

export const peso = (n: number | string) =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(Number(n));

/** Reads a station QR ("SHQR1:<station>:<code>"). */
export function parseStationQr(text: string): { station_id: string; code: string } | null {
  const m = /^SHQR1:([0-9a-f-]{36}):(\d{6})$/i.exec(text.trim());
  return m ? { station_id: m[1]!, code: m[2]! } : null;
}
