export type WindowState = 'not_started' | 'early_draft' | 'open' | 'override' | 'closed';

export interface ShiftWindow {
  starts_at: string;
  ends_at: string;
  window_opens_at: string;
  window_closes_at: string;
  override_expires_at?: string | null;
  allow_early_draft?: boolean;
}

/**
 * Display-only classification. The server computes the authoritative state with the
 * database clock and sends it; the browser uses this to keep a countdown ticking between
 * refreshes, offset by the server clock skew.
 */
export function classifyWindow(w: ShiftWindow, nowMs: number): WindowState {
  const t = (s: string) => new Date(s).getTime();
  if (nowMs >= t(w.window_opens_at) && nowMs < t(w.window_closes_at)) return 'open';
  // Same order as app.window_state() in the database.
  if (w.override_expires_at && nowMs < t(w.override_expires_at)) return 'override';
  if (nowMs >= t(w.window_closes_at)) return 'closed';
  if (nowMs >= t(w.starts_at) && w.allow_early_draft !== false) return 'early_draft';
  return 'not_started';
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
