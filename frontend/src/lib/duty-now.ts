import type { AttendanceRecord } from '@/lib/workforce';

/**
 * Where a staff member stands with their duty right now, from their attendance records (which
 * include today's and tomorrow's scheduled duties). Used by the Attendance page and Today.
 *
 * The server stays the judge: it matches punches to the duty and computes the late minutes that
 * the DTR and payroll use. This only explains it to the person while it happens.
 */
export type DutyNow =
  | { state: 'upcoming'; record: AttendanceRecord; startsInMinutes: number } // within the time-in window, not started
  | { state: 'late'; record: AttendanceRecord; lateMinutes: number } // started, no time-in yet
  | { state: 'on_duty'; record: AttendanceRecord; endsInMinutes: number } // timed in, duty not over
  | { state: 'time_out_due'; record: AttendanceRecord; overMinutes: number } // timed in, duty over, no time-out
  | { state: 'done'; record: AttendanceRecord } // timed in and out today
  | { state: 'off'; next: AttendanceRecord | null };

/** Time-in opens this long before a duty (the sample policy's matching window). */
export const TIME_IN_OPENS_MINUTES = 120;
/** A finished duty stays on the card this long after its end, so the person sees the result. */
const DONE_VISIBLE_MINUTES = 240;

const mins = (ms: number) => Math.floor(ms / 60_000);

export function dutyNow(records: readonly AttendanceRecord[], now: number): DutyNow {
  const live = records
    .filter((r) => r.status !== 'excused' && r.status !== 'absent')
    .map((r) => ({ r, start: Date.parse(r.scheduled_start), end: Date.parse(r.scheduled_end) }))
    .sort((a, b) => a.start - b.start);

  // 1. Timed in and not out yet: the duty the person is on (even if the duty already ended).
  const open = live.find((x) => x.r.time_in && !x.r.time_out && now < x.end + DONE_VISIBLE_MINUTES * 60_000);
  if (open) {
    return now < open.end
      ? { state: 'on_duty', record: open.r, endsInMinutes: Math.max(0, Math.ceil((open.end - now) / 60_000)) }
      : { state: 'time_out_due', record: open.r, overMinutes: mins(now - open.end) };
  }
  // 2. A duty under way without a time-in: late, counting.
  const started = live.find((x) => !x.r.time_in && x.start <= now && now < x.end);
  if (started) return { state: 'late', record: started.r, lateMinutes: mins(now - started.start) };
  // 3. A duty about to start (time-in is open).
  const soon = live.find((x) => !x.r.time_in && x.start > now && x.start - now <= TIME_IN_OPENS_MINUTES * 60_000);
  if (soon) return { state: 'upcoming', record: soon.r, startsInMinutes: Math.ceil((soon.start - now) / 60_000) };
  // 4. Just finished.
  const done = [...live].reverse().find((x) => x.r.time_in && x.r.time_out && x.start <= now && now - x.end < DONE_VISIBLE_MINUTES * 60_000);
  if (done) return { state: 'done', record: done.r };
  // 5. Nothing now: the next duty, if any.
  const next = live.find((x) => x.start > now && !x.r.time_in);
  return { state: 'off', next: next?.r ?? null };
}
