const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(options: Intl.DateTimeFormatOptions, timeZone?: string) {
  const key = JSON.stringify([options, timeZone]);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-PH', { ...options, timeZone });
    cache.set(key, f);
  }
  return f;
}

const d = (v: string | Date | number) => (v instanceof Date ? v : new Date(v));

/** 2:30 PM */
export const time = (v: string | Date | number, tz?: string) => fmt({ hour: 'numeric', minute: '2-digit' }, tz).format(d(v));
/** Mon, 26 Oct */
export const day = (v: string | Date | number, tz?: string) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }, tz).format(d(v));
/** 26 Oct, 2:30 PM */
export const dateTime = (v: string | Date | number, tz?: string) =>
  fmt({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, tz).format(d(v));
/** Mon, 26 Oct 2026 */
export const longDate = (v: string | Date | number, tz?: string) =>
  fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, tz).format(d(v));

/** "6:00 AM – 2:00 PM" (+1 for overnight) */
export function shiftRange(s: { starts_at: string; ends_at: string; timezone: string }) {
  const startDay = fmt({ day: 'numeric' }, s.timezone).format(d(s.starts_at));
  const endDay = fmt({ day: 'numeric' }, s.timezone).format(d(s.ends_at));
  return `${time(s.starts_at, s.timezone)} – ${time(s.ends_at, s.timezone)}${startDay !== endDay ? ' (+1)' : ''}`;
}

export function relative(v: string | Date | number, nowMs = Date.now()) {
  const diff = d(v).getTime() - nowMs;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function tzLabel(tz: string) {
  const part = fmt({ timeZoneName: 'short' }, tz)
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}
