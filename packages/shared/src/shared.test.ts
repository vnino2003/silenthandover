import { describe, expect, it } from 'vitest';
import { classifyWindow, DEMO_SAMPLE_REPORT, ReportSubmission, ReviewDecision } from './index';

describe('ReportSubmission', () => {
  it('accepts the demo sample', () => {
    expect(ReportSubmission.safeParse(DEMO_SAMPLE_REPORT).success).toBe(true);
  });

  it('requires an explicit "none" instead of silence', () => {
    const r = ReportSubmission.safeParse({ completed_work: 'Did the count', unresolved_issues: '', pending_tasks: '' });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(['unresolved_issues', 'pending_tasks']);
    const ok = ReportSubmission.safeParse({ completed_work: 'Did the count', no_unresolved_issues: true, no_pending_tasks: true });
    expect(ok.success).toBe(true);
  });

  it('rejects contradictory answers', () => {
    const r = ReportSubmission.safeParse({ completed_work: 'Did it', unresolved_issues: 'Leak', no_unresolved_issues: true, no_pending_tasks: true });
    expect(r.success).toBe(false);
  });
});

describe('ReviewDecision', () => {
  it('requires a note when rejecting or requesting revision', () => {
    expect(ReviewDecision.safeParse({ decision: 'rejected', note: '' }).success).toBe(false);
    expect(ReviewDecision.safeParse({ decision: 'revision_requested', note: 'Add PO numbers' }).success).toBe(true);
  });
});

describe('classifyWindow', () => {
  const w = {
    starts_at: '2026-10-26T06:00:00+08:00',
    ends_at: '2026-10-26T14:00:00+08:00',
    window_opens_at: '2026-10-26T13:30:00+08:00',
    window_closes_at: '2026-10-26T14:30:00+08:00',
  };
  const at = (s: string) => new Date(s).getTime();
  it.each([
    ['2026-10-26T05:00:00+08:00', 'not_started'],
    ['2026-10-26T09:00:00+08:00', 'early_draft'],
    ['2026-10-26T13:45:00+08:00', 'open'],
    ['2026-10-26T14:31:00+08:00', 'closed'],
  ])('%s → %s', (time, state) => {
    expect(classifyWindow(w, at(time))).toBe(state);
  });
});
