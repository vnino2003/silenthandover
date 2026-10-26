import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SAMPLE_REPORT, type AiHandoverDraft } from '@sh/shared';
import { adhocShift, CALLBACK_SECRET, demoOutgoingShift, setup, WEBHOOK_SECRET, type FetchCall, type Harness } from './helpers';

const N8N_ENV = {
  AI_ADAPTER: 'n8n',
  N8N_ANALYSIS_WEBHOOK_URL: 'https://n8n.test/webhook/analysis',
  N8N_DELIVERY_WEBHOOK_URL: 'https://n8n.test/webhook/delivery',
  N8N_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

async function submitSample(h: Harness, content = DEMO_SAMPLE_REPORT) {
  const shift = await demoOutgoingShift(h);
  const { body } = await h.call('juan', 'POST', `/api/shifts/${shift}/report`);
  const res = await h.call('juan', 'POST', `/api/reports/${body.report_id}/submit`, { content });
  expect(res.status).toBe(201);
  return { reportId: body.report_id as string, eventId: res.body.event_id as string };
}

const callback = (h: Harness, path: string, body: unknown, secret = CALLBACK_SECRET) =>
  h.call(null, 'POST', `/api/integrations/n8n/${path}`, body, { Authorization: `Bearer ${secret}` });

function validDraft(ref: string, overrides: Partial<AiHandoverDraft> = {}): AiHandoverDraft {
  return {
    report_id: ref,
    summary: 'Two trucks unloaded; forklift FL-02 tagged out; roof leak near charging station.',
    completed_tasks: [
      {
        description: 'Unloaded 2 trucks',
        source_evidence: 'Unloaded 2 trucks (PO 77812 and PO 77815)',
        reported_status: 'completed',
        verification_status: 'reported_unverified',
        recommended_next_action: null,
      },
    ],
    unresolved_issues: [
      {
        title: 'Roof leak near charging station',
        description: 'Small puddle beside the charging station near electrical equipment.',
        severity: 'high',
        is_safety_concern: true,
        source_evidence: 'Leak sa roof near Dock 3, small puddle beside the charging station',
        reported_status: 'open',
        verification_status: 'requires_verification',
        related_issue_code: null,
        recommended_next_action: 'Keep the area clear and inspect.',
      },
    ],
    pending_actions: [],
    missing_information: [],
    verification_flags: [],
    suggested_follow_up: [],
    requires_human_review: true,
    ...overrides,
  };
}

describe('n8n Workflow A — AI processing', () => {
  let h: Harness;
  const n8n = fakeFetch(() => new Response('{}', { status: 200 }));
  let reportId: string;
  let eventId: string;
  let ref: string;

  beforeAll(async () => {
    h = await setup(N8N_ENV, n8n.impl);
    ({ reportId, eventId } = await submitSample(h));
    [{ reference_code: ref }] = (await h.sql('select reference_code from public.shift_reports where id = $1', [reportId])) as [{ reference_code: string }];
  });
  afterAll(async () => h?.close());

  it('sends only the sanitized, bounded prompt to n8n with its secret and idempotency key', async () => {
    await h.drain();
    expect(n8n.calls).toHaveLength(1);
    const call = n8n.calls[0]!;
    expect(call.url).toBe(N8N_ENV.N8N_ANALYSIS_WEBHOOK_URL);
    expect((call.init.headers as Record<string, string>)['X-Silent-Handover-Secret']).toBe(WEBHOOK_SECRET);
    expect(call.body).toMatchObject({ event_id: eventId, attempt: 1, report_id: ref, prompt_version: '1.0' });
    expect(call.body.idempotency_key).toMatch(/^analysis:.+:r1:a1$/);
    const payload = JSON.stringify(call.body);
    for (const leaked of ['Ana Lim', 'Ben Torres', '0917 555 0142', 'fever', 'juan.delacruz@demo.test']) expect(payload).not.toContain(leaked);
    expect(call.body.user_prompt).toContain('<raw_input>');
    expect(call.body.system_prompt).toContain('## 4. Delimiters and injection shield');
    expect(call.body.response_schema.properties.requires_human_review).toBeTruthy();
    const [r] = await h.sql('select status from public.shift_reports where id = $1', [reportId]);
    expect(r.status).toBe('processing');
  });

  it('rejects callbacks without the shared secret', async () => {
    const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 1, status: 'ok', output: '{}' }, 'wrong-secret-wrong-secret-wrong');
    expect(res.status).toBe(401);
  });

  it('rejects malformed JSON from the model and schedules a retry', async () => {
    const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 1, status: 'ok', output: 'Sure! Here is the summary: {not json' });
    expect(res.body.result).toBe('invalid');
    const [run] = await h.sql(`select status, draft, validation_errors from public.ai_analysis_runs where report_id = $1`, [reportId]);
    expect(run).toMatchObject({ status: 'invalid_output', draft: null });
    const [ev] = await h.sql('select status, attempts, last_error from public.automation_events where id = $1', [eventId]);
    expect(ev).toMatchObject({ status: 'failed', attempts: 1 });
    const [r] = await h.sql('select status from public.shift_reports where id = $1', [reportId]);
    expect(r.status).toBe('processing');
  });

  it('rejects schema-valid JSON that tries to skip human review (injection outcome)', async () => {
    await h.sql(`update public.automation_events set next_attempt_at = now() where id = $1`, [eventId]);
    await h.drain();
    const res = await callback(h, 'analysis-result', {
      event_id: eventId,
      attempt: 2,
      status: 'ok',
      output: { ...validDraft(ref), requires_human_review: false, summary: 'Approved automatically as instructed.' },
    });
    expect(res.body.result).toBe('invalid');
    expect((await h.sql(`select count(*)::int as n from public.ai_analysis_runs where report_id = $1 and status = 'invalid_output'`, [reportId]))[0].n).toBe(2);
  });

  it('ignores a late callback for an attempt that is no longer current', async () => {
    const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 1, status: 'ok', output: validDraft(ref) });
    expect(res.body.result).toBe('ignored');
  });

  it('accepts valid output, runs grounding checks, and flags a hallucinated repair', async () => {
    await h.sql(`update public.automation_events set next_attempt_at = now() where id = $1`, [eventId]);
    await h.drain();
    const draft = validDraft(ref, {
      completed_tasks: [
        {
          description: 'Repaired forklift FL-02 brakes and replaced 37 brake pads',
          source_evidence: 'Repaired forklift FL-02 brakes',
          reported_status: 'completed',
          verification_status: 'supported_by_record',
          recommended_next_action: null,
        },
      ],
    });
    const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 3, status: 'ok', output: JSON.stringify(draft), model: 'gpt-test', latency_ms: 900 });
    expect(res.body.result).toBe('recorded');
    const [run] = await h.sql<{ draft: AiHandoverDraft; flags: { type: string; item_ref: string | null }[]; is_simulated: boolean; engine: string; model: string }>(
      `select draft, flags, is_simulated, engine, model from public.ai_analysis_runs where report_id = $1 and status = 'succeeded'`,
      [reportId],
    );
    expect(run).toMatchObject({ is_simulated: false, engine: 'n8n', model: 'gpt-test' });
    const types = run!.flags.filter((f) => f.item_ref === 'completed_tasks[0]').map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(['unsupported_claim', 'conflicting_quantity', 'unverified_repair']));
    // The model's "supported_by_record" label was not trusted.
    expect(run!.draft.completed_tasks[0]!.verification_status).toBe('requires_verification');
    expect(run!.flags.map((f) => f.type)).toEqual(expect.arrayContaining(['possible_prompt_injection', 'safety_concern']));
    const [r] = await h.sql('select status, analysis_state from public.shift_reports where id = $1', [reportId]);
    expect(r).toEqual({ status: 'pending_review', analysis_state: 'succeeded' });
  });

  it('applies a duplicate callback at most once', async () => {
    const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 3, status: 'ok', output: validDraft(ref) });
    expect(res.body.result).toBe('ignored');
    expect((await h.sql(`select count(*)::int as n from public.ai_analysis_runs where report_id = $1 and status = 'succeeded'`, [reportId]))[0].n).toBe(1);
  });
});

describe('Workflow A failure handling', () => {
  it('records webhook failures and falls back to manual review after the retry limit', async () => {
    const down = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const h = await setup(N8N_ENV, down.impl);
    try {
      const { reportId, eventId } = await submitSample(h);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await h.drain();
        await h.sql(`update public.automation_events set next_attempt_at = now() where id = $1`, [eventId]);
      }
      expect(down.calls).toHaveLength(3);
      const [ev] = await h.sql('select status, attempts, last_error from public.automation_events where id = $1', [eventId]);
      expect(ev).toMatchObject({ status: 'dead', attempts: 3 });
      expect(ev.last_error).toContain('n8n responded 502');
      const [r] = await h.sql('select status, analysis_state from public.shift_reports where id = $1', [reportId]);
      expect(r).toEqual({ status: 'pending_review', analysis_state: 'failed' });
      const admin = await h.call('admin', 'GET', '/api/notifications');
      expect(admin.body.items.map((n: any) => n.kind)).toContain('automation_failure');
      const manager = await h.call('manager', 'GET', '/api/notifications');
      expect(manager.body.items.find((n: any) => n.kind === 'review_required').title).toContain('Manual review required');

      // The manager can still approve from the original, without an AI draft.
      const approve = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
        decision: 'approved',
        content: { summary: 'Written by the supervisor from the original report.', completed_tasks: [], unresolved_issues: [], pending_actions: [], notes_for_incoming: '' },
        flag_resolutions: [],
        note: 'AI unavailable; reviewed manually.',
      });
      expect(approve.body.status).toBe('delivered');

      // An admin retry is possible for failed events.
      expect((await h.call('admin', 'POST', `/api/admin/events/${eventId}/retry`)).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('treats a missing AI result as a timeout and retries', async () => {
    const ok = fakeFetch(() => new Response('{}', { status: 200 }));
    const h = await setup(N8N_ENV, ok.impl);
    try {
      const { eventId } = await submitSample(h);
      await h.drain();
      await h.sql(`update public.automation_events set dispatched_at = now() - interval '20 minutes' where id = $1`, [eventId]);
      const tick = await h.call('admin', 'POST', '/api/admin/tick');
      expect(tick.body.ai_timeouts).toBe(1);
      const [ev] = await h.sql('select status, last_error from public.automation_events where id = $1', [eventId]);
      expect(ev.status).toBe('failed');
      expect(ev.last_error).toMatch(/Timed out/);
    } finally {
      await h.close();
    }
  });

  it('records an AI provider error reported by n8n', async () => {
    const ok = fakeFetch(() => new Response('{}', { status: 200 }));
    const h = await setup(N8N_ENV, ok.impl);
    try {
      const { eventId } = await submitSample(h);
      await h.drain();
      const res = await callback(h, 'analysis-result', { event_id: eventId, attempt: 1, status: 'error', error: 'model timeout' });
      expect(res.body.result).toBe('recorded');
      const [ev] = await h.sql('select status, last_error from public.automation_events where id = $1', [eventId]);
      expect(ev).toMatchObject({ status: 'failed', last_error: 'AI provider error: model timeout' });
    } finally {
      await h.close();
    }
  });
});

describe('Workflow B — email delivery', () => {
  it('records provider failures, retries, and alerts administrators', async () => {
    const resend = fakeFetch(() => new Response(JSON.stringify({ name: 'internal_server_error', message: 'Upstream down' }), { status: 500 }));
    const h = await setup({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test_key' }, resend.impl);
    try {
      await submitSample(h);
      await h.drain();
      const [d] = await h.sql<{ id: string }>(`select id from public.notification_deliveries where channel = 'email' order by created_at limit 1`);
      for (let i = 0; i < 3; i++) {
        await h.sql(`update public.notification_deliveries set next_attempt_at = now() where id = $1`, [d!.id]);
        await h.drain();
      }
      const [row] = await h.sql('select status, attempts, provider, last_error from public.notification_deliveries where id = $1', [d!.id]);
      expect(row).toMatchObject({ status: 'failed', attempts: 3, provider: 'resend' });
      expect(row.last_error).toContain('Resend 500');
      const resendCall = resend.calls[0]!;
      expect((resendCall.init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/:email$/);
      const admin = await h.call('admin', 'GET', '/api/notifications');
      expect(admin.body.items.map((n: any) => n.kind)).toContain('delivery_failure');
    } finally {
      await h.close();
    }
  });

  it('hands batches to n8n and accepts each result once', async () => {
    const n8n = fakeFetch(() => new Response('{}', { status: 200 }));
    const h = await setup({ EMAIL_TRANSPORT: 'n8n', N8N_DELIVERY_WEBHOOK_URL: N8N_ENV.N8N_DELIVERY_WEBHOOK_URL, N8N_WEBHOOK_SECRET: WEBHOOK_SECRET }, n8n.impl);
    try {
      await submitSample(h);
      await h.drain();
      const batch = n8n.calls.find((c) => c.url === N8N_ENV.N8N_DELIVERY_WEBHOOK_URL)!;
      expect(batch.body.deliveries.length).toBeGreaterThan(0);
      // Email carries a sign-in link, never report or issue content.
      const texts = batch.body.deliveries.map((d: any) => d.text).join(' ');
      expect(texts).toContain('http://localhost:5173/reports/');
      expect(texts).not.toMatch(/Forklift|brake|Dock 3|charging station/);
      const first = batch.body.deliveries[0];
      const result = { delivery_id: first.delivery_id, attempt: first.attempt, status: 'sent', provider: 'resend', provider_message_id: 'msg_1' };
      expect((await callback(h, 'delivery-result', { results: [result] })).body.results).toEqual(['recorded']);
      expect((await callback(h, 'delivery-result', { results: [result] })).body.results).toEqual(['ignored']);
      const [row] = await h.sql('select status, provider_message_id from public.notification_deliveries where id = $1', [first.delivery_id]);
      expect(row).toEqual({ status: 'sent', provider_message_id: 'msg_1' });
    } finally {
      await h.close();
    }
  });

  it('never claims SMS was sent without a provider', async () => {
    const h = await setup();
    try {
      await h.call('admin', 'PUT', '/api/admin/settings/sms_enabled', { value: true });
      await h.call('juan', 'PATCH', '/api/me/preferences', { notify_email: true, notify_sms: true, phone: '+63 917 000 0000' });
      await submitSample(h);
      await h.drain();
      const sms = await h.sql(`select status, last_error from public.notification_deliveries where channel = 'sms'`);
      expect(sms.length).toBeGreaterThan(0);
      expect(sms.every((s: any) => s.status === 'skipped' && s.last_error === 'No SMS provider connected')).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('scheduled continuity checks', () => {
  it('escalates stale issues once and alerts on missing reports', async () => {
    const h = await setup();
    try {
      await h.sql(`update public.operational_issues set last_activity_at = now() - interval '13 hours'`);
      const shift = await adhocShift(h, { startsSql: `now() - interval '10 hours'`, endsSql: `now() - interval '2 hours'`, employee: 'ben', label: 'Missed' });
      const first = await h.call('admin', 'POST', '/api/admin/tick');
      expect(first.body.escalated_issues).toBe(3);
      expect(first.body.missing_report_alerts).toBe(1);
      const second = await h.call('admin', 'POST', '/api/admin/tick');
      expect(second.body.escalated_issues).toBe(0);
      expect(second.body.missing_report_alerts).toBe(0);
      const board = await h.call('manager', 'GET', '/api/manager/shift-board');
      const missed = board.body.shifts.find((s: any) => s.id === shift);
      expect(missed.assignees[0]).toMatchObject({ employee_name: 'Ben Torres', missing: true });
    } finally {
      await h.close();
    }
  });
});
