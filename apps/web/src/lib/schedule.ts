/**
 * Date helpers and labels shared by the schedule and leave pages. Dates are plain YYYY-MM-DD
 * strings in the department's calendar (the API returns shift_date and leave dates that way),
 * so day arithmetic is done in UTC to avoid daylight-saving and time-zone shifts.
 */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const parseDay = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso: string, n: number) => isoDay(new Date(parseDay(iso).getTime() + n * 86_400_000));
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
/** ISO weekday, Monday = 1 … Sunday = 7. */
export const isoWeekday = (iso: string) => ((parseDay(iso).getUTCDay() + 6) % 7) + 1;
export const startOfWeek = (iso: string) => addDays(iso, 1 - isoWeekday(iso));
export const startOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
export const endOfMonth = (iso: string) => {
  const d = parseDay(startOfMonth(iso));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return addDays(isoDay(d), -1);
};
export function rangeDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-PH', { ...opts, timeZone: 'UTC' });
const weekdayShort = fmt({ weekday: 'short' });
const dayMonth = fmt({ day: 'numeric', month: 'short' });
const weekdayDayMonth = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const longDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const monthYear = fmt({ month: 'long', year: 'numeric' });
export const labelWeekday = (iso: string) => weekdayShort.format(parseDay(iso));
export const labelDayMonth = (iso: string) => dayMonth.format(parseDay(iso));
export const labelDay = (iso: string) => weekdayDayMonth.format(parseDay(iso));
export const labelLongDay = (iso: string) => longDay.format(parseDay(iso));
export const labelMonth = (iso: string) => monthYear.format(parseDay(iso));
export const labelRange = (from: string, to: string) => (from === to ? labelDay(from) : `${labelDay(from)} – ${labelDay(to)}`);

export type DayMarkKind = 'rest_day' | 'day_off';
export const MARK_LABEL: Record<DayMarkKind, string> = { rest_day: 'Rest day', day_off: 'Day off' };

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: 'warn' | 'ok' | 'bad' | 'neutral' }> = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Not approved', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** The six-week grid of a month view (Monday first), including the trailing days of the weeks. */
export function monthGrid(iso: string): string[] {
  const first = startOfWeek(startOfMonth(iso));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}
