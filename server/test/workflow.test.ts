import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_SAMPLE_REPORT } from '@sh/shared';
import { adhocShift, demoIncomingShift, demoOutgoingShift, flagResolutionsFor, setup, type Harness } from './helpers';

/**
 * End-to-end workflow against the real migrations, RLS policies and workflow functions
 * (embedded PostgreSQL), using the development AI simulator. Steps run in order.
 */
describe('shift report → AI draft → human approval → delivery → continuity', () => {
  let h: Harness;
  let shiftId: string;
  let reportId: string;
  let approvedIssueIds: string[] = [];

  beforeAll(async () => {
    h = await setup();
    shiftId = await demoOutgoingShift(h);
  });
  afterAll(async () => h?.close());

  it('rejects a wrong password with a generic message', async () => {
    const res = await h.call(null, 'POST', '/api/auth/login', { email: 'juan.delacruz@demo.test', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect');
  });

  it('logs an employee in and returns their profile', async () => {
    const res = await h.call('juan', 'GET', '/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'employee', full_name: 'Juan Dela Cruz', department_name: 'Warehouse Inventory' });
  });

  it('requires a session', async () => {
    expect((await h.call(null, 'GET', '/api/me')).status).toBe(401);
  });

  it('blocks employees from manager and admin endpoints', async () => {
    expect((await h.call('juan', 'GET', '/api/manager/queue')).status).toBe(403);
    expect((await h.call('juan', 'GET', '/api/admin/users')).status).toBe(403);
    expect((await h.call('manager', 'GET', '/api/admin/users')).status).toBe(403);
  });

  it('shows the assigned shift with an open reporting window', async () => {
    const res = await h.call('juan', 'GET', '/api/employee/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.current_shift).toMatchObject({ id: shiftId, window_state: 'open', department_name: 'Warehouse Inventory' });
  });

  it('creates one draft per employee and shift', async () => {
    const a = await h.call('juan', 'POST', `/api/shifts/${shiftId}/report`);
    const b = await h.call('juan', 'POST', `/api/shifts/${shiftId}/report`);
    expect(a.status).toBe(200);
    expect(b.body.report_id).toBe(a.body.report_id);
    reportId = a.body.report_id;
  });

  it('saves drafts without requiring every field', async () => {
    const res = await h.call('juan', 'PUT', `/api/reports/${reportId}/draft`, { content: { completed_work: 'Started unloading' } });
    expect(res.status).toBe(200);
  });

  it('rejects a submission with missing required fields', async () => {
    const res = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, { content: { completed_work: '' } });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['completed_work', 'unresolved_issues', 'pending_tasks']));
  });

  it('accepts the final submission and refuses a duplicate', async () => {
    const res = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, { content: DEMO_SAMPLE_REPORT });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ revision_no: 1, is_late: false });
    const dup = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, { content: DEMO_SAMPLE_REPORT });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('already_submitted');
    const [rev] = await h.sql('select count(*)::int as n from public.report_revisions where report_id = $1', [reportId]);
    expect(rev.n).toBe(1);
  });

  it('keeps original submissions immutable', async () => {
    await expect(h.sql(`update public.report_revisions set content = '{}'::jsonb where report_id = $1`, [reportId])).rejects.toThrow(/SH:immutable/);
  });

  it('processes the report with the clearly labeled simulator and moves it to Pending Review', async () => {
    await h.drain();
    const [r] = await h.sql('select status, analysis_state from public.shift_reports where id = $1', [reportId]);
    expect(r).toEqual({ status: 'pending_review', analysis_state: 'simulated' });
    const [run] = await h.sql('select engine, is_simulated, status, prompt_version from public.ai_analysis_runs where report_id = $1', [reportId]);
    expect(run).toEqual({ engine: 'dev-simulator', is_simulated: true, status: 'succeeded', prompt_version: '1.0' });
  });

  it('removes personal information before anything is sent for analysis', async () => {
    const [input] = await h.sql('select sanitized_text, redaction_counts, name_mapping from internal.analysis_inputs where report_id = $1', [reportId]);
    const text: string = input.sanitized_text;
    for (const leaked of ['Ana Lim', 'Ben Torres', '0917', '555 0142', 'fever', 'Mang Tony', 'Kuya Ramon']) expect(text).not.toContain(leaked);
    expect(text).toMatch(/\[EMP-[A-Z0-9]{6}\]/);
    expect(text).toContain('[PHONE-REDACTED]');
    expect(text).toContain('[MEDICAL-REDACTED]');
    expect(input.redaction_counts).toMatchObject({ phone: 1, medical: 1, other_person: 2 });
    expect(Object.values(input.name_mapping)).toEqual(expect.arrayContaining(['Ana Lim', 'Ben Torres']));
  });

  it('flags the injection attempt, the unverified repair and the safety concern', async () => {
    const [run] = await h.sql<{ flags: { type: string; origin: string }[] }>('select flags from public.ai_analysis_runs where report_id = $1', [reportId]);
    const types = run!.flags.map((f) => f.type);
    expect(types).toContain('possible_prompt_injection');
    expect(types).toContain('unverified_repair');
    expect(types).toContain('safety_concern');
    expect(run!.flags.find((f) => f.type === 'possible_prompt_injection')!.origin).toBe('injection_detector');
  });

  it('did not obey the embedded instruction: nothing was approved or resolved', async () => {
    expect((await h.sql(`select count(*)::int as n from public.handover_approvals where report_id = $1`, [reportId]))[0].n).toBe(0);
    expect((await h.sql(`select count(*)::int as n from public.operational_issues where status = 'resolved'`))[0].n).toBe(0);
  });

  it('notifies the department manager that review is required', async () => {
    const res = await h.call('manager', 'GET', '/api/notifications');
    expect(res.body.items.map((n: any) => n.kind)).toContain('review_required');
  });

  it('never shows the unapproved draft to employees', async () => {
    expect((await h.sqlAs('juan', 'select * from public.ai_analysis_runs')).length).toBe(0);
    expect((await h.sqlAs('ana', 'select * from public.ai_analysis_runs')).length).toBe(0);
    const incoming = await h.call('ana', 'GET', '/api/handovers/incoming');
    expect(incoming.body).toEqual([]);
  });

  it('shows the reviewer the original, the draft with names restored, and what was sent to AI', async () => {
    const res = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    expect(res.status).toBe(200);
    expect(res.body.revisions[0].content.completed_work).toContain('Ana Lim');
    expect(JSON.stringify(res.body.runs[0].draft)).toContain('Ana Lim');
    expect(res.body.analysis_input.sanitized_text).not.toContain('Ana Lim');
    expect(res.body.incoming_shifts.map((s: any) => s.assignees)).toEqual([['Ana Lim', 'Ben Torres']]);
  });

  it('keeps managers out of other departments', async () => {
    const res = await h.call('facmanager', 'GET', `/api/manager/reports/${reportId}`);
    expect(res.status).toBe(404);
    const decide = await h.call('facmanager', 'POST', `/api/manager/reports/${reportId}/decision`, { decision: 'rejected', note: 'Not mine to reject' });
    expect(decide.status).toBe(403);
  });

  it('refuses approval by an employee, even via the database function directly', async () => {
    const res = await h.call('juan', 'POST', `/api/manager/reports/${reportId}/decision`, { decision: 'rejected', note: 'self-reject' });
    expect(res.status).toBe(403);
    await expect(
      h.sqlAs('juan', `select app.decide_report($1, 'rejected', null, '[]'::jsonb, 'trying to bypass')`, [reportId]),
    ).rejects.toThrow(/SH:forbidden/);
  });

  it('refuses approval until every verification flag has a decision', async () => {
    const detail = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    const draft = detail.body.runs[0].draft;
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
      decision: 'approved',
      content: { summary: draft.summary, completed_tasks: [], unresolved_issues: [], pending_actions: [], notes_for_incoming: '' },
      flag_resolutions: [],
      note: '',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('flags_unresolved');
  });

  it('approves the reviewed handover and delivers it to the incoming shift', async () => {
    const detail = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    const run = detail.body.runs[0];
    const existing = detail.body.open_issues.find((i: any) => i.title.startsWith('Dock 3 door'));
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
      decision: 'approved',
      content: {
        summary: 'Two trucks unloaded; pallet count needs recheck (46 vs 44). Forklift FL-02 tagged out. Roof leak near charging station — keep clear.',
        completed_tasks: [{ description: 'Unloaded PO 77812 and PO 77815' }],
        unresolved_issues: [
          { title: 'Roof leak near Dock 3 charging station', description: 'Puddle near electrical equipment.', severity: 'high', is_safety_concern: true, link_issue_id: null, initial_status: 'open' },
          { title: 'Pallet count mismatch PO 77812/77815', description: '46 counted vs 44 scanned.', severity: 'medium', is_safety_concern: false, link_issue_id: null, initial_status: 'pending_verification' },
          { title: 'Dock 3 door sensor still stops halfway', description: '', severity: 'medium', is_safety_concern: false, link_issue_id: existing.id, initial_status: 'open' },
        ],
        pending_actions: [{ description: 'Wrap and label 6 pallets for Northstar Pharmacy, truck ETA 4pm' }],
        notes_for_incoming: 'Check the charging station area first.',
      },
      flag_resolutions: flagResolutionsFor(run.flags),
      note: 'Verified against MR-2291; conveyor jam fix not yet confirmed.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'delivered', recipients: 2 });

    const [approval] = await h.sql('select approved_content from public.handover_approvals where report_id = $1', [reportId]);
    approvedIssueIds = approval.approved_content.unresolved_issues.map((i: any) => i.issue_id);
    expect(approvedIssueIds).toHaveLength(3);
    expect(approvedIssueIds[2]).toBe(existing.id);
    const statuses = await h.sql('select id, status from public.operational_issues where id = any($1)', [approvedIssueIds]);
    expect(Object.fromEntries(statuses.map((s: any) => [s.id, s.status]))).toEqual({
      [approvedIssueIds[0]!]: 'open',
      [approvedIssueIds[1]!]: 'pending_verification',
      [approvedIssueIds[2]!]: 'in_progress',
    });
  });

  it('cannot approve the same report twice', async () => {
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, { decision: 'rejected', note: 'second decision' });
    expect(res.status).toBe(409);
  });

  it('notifies the outgoing employee and the incoming staff, and records email deliveries', async () => {
    await h.drain();
    const juan = await h.call('juan', 'GET', '/api/notifications');
    expect(juan.body.items.map((n: any) => n.kind)).toContain('report_approved');
    const ana = await h.call('ana', 'GET', '/api/notifications');
    expect(ana.body.items.map((n: any) => n.kind)).toContain('handover_delivered');
    const deliveries = await h.sql(`select status, provider from public.notification_deliveries where channel = 'email'`);
    expect(deliveries.length).toBeGreaterThan(0);
    // Development transport never claims an email was sent.
    expect(deliveries.every((d: any) => d.status === 'simulated' && d.provider === 'dev-outbox')).toBe(true);
    const [event] = await h.sql(`select status from public.automation_events where kind = 'handover_delivery' and report_id = $1`, [reportId]);
    expect(event.status).toBe('completed');
  });

  it('delivering the same approval again creates nothing new', async () => {
    const [{ id }] = await h.sql('select id from public.handover_approvals where report_id = $1', [reportId]);
    const [{ n }] = await h.sql('select app.deliver_approval($1) as n', [id]);
    expect(n).toBe(0);
    expect((await h.sql('select count(*)::int as n from public.handover_deliveries where approval_id = $1', [id]))[0].n).toBe(2);
  });

  it('revokes a handover when the recipient is removed from the incoming shift', async () => {
    const [{ shift_id, reference_code }] = await h.sql(
      `select d.shift_id, r.reference_code from public.handover_deliveries d
       join public.shift_reports r on r.id = d.report_id
       where d.report_id = $1 and d.recipient_id = $2 and d.revoked_at is null`,
      [reportId, h.ids.ben],
    );
    expect((await h.call('manager', 'DELETE', `/api/manager/schedule/${shift_id}/assignments/${h.ids.ben}`)).status).toBe(200);
    const afterRemoval = await h.call('ben', 'GET', '/api/handovers/incoming');
    expect(afterRemoval.body.some((item: any) => item.report_reference === reference_code)).toBe(false);

    expect((await h.call('manager', 'POST', `/api/manager/schedule/${shift_id}/assignments`, { employee_id: h.ids.ben })).status).toBe(201);
    const afterReassignment = await h.call('ben', 'GET', '/api/handovers/incoming');
    expect(afterReassignment.body.some((item: any) => item.report_reference === reference_code)).toBe(true);
  });

  it('lets incoming staff read and acknowledge the approved handover — once', async () => {
    const list = await h.call('ana', 'GET', '/api/handovers/incoming');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].approved_content.summary).toContain('Forklift FL-02');
    expect(list.body[0].acknowledged_at).toBeNull();
    const before = await h.sql('select id, status from public.operational_issues order by id');
    const ack = await h.call('ana', 'POST', `/api/handovers/${list.body[0].delivery_id}/acknowledge`, { note: 'Read at turnover' });
    expect(ack.body.new).toBe(true);
    const again = await h.call('ana', 'POST', `/api/handovers/${list.body[0].delivery_id}/acknowledge`, { note: '' });
    expect(again.body.new).toBe(false);
    // Acknowledgment never changes issue status.
    expect(await h.sql('select id, status from public.operational_issues order by id')).toEqual(before);
    // Ben cannot acknowledge Ana's delivery.
    expect((await h.call('ben', 'POST', `/api/handovers/${list.body[0].delivery_id}/acknowledge`, { note: '' })).status).toBe(404);
  });

  it('does not give incoming staff the raw report', async () => {
    expect((await h.sqlAs('ana', 'select * from public.report_revisions where report_id = $1', [reportId])).length).toBe(0);
    expect((await h.sqlAs('ana', 'select * from public.shift_reports where id = $1', [reportId])).length).toBe(0);
  });

  it('keeps unresolved issues open for the next shift', async () => {
    const res = await h.call('ben', 'GET', '/api/issues?scope=active');
    const ids = res.body.map((i: any) => i.id);
    for (const id of approvedIssueIds) expect(ids).toContain(id);
  });

  it('requires an authorized person to verify a resolution', async () => {
    const issue = approvedIssueIds[0]!;
    const noNote = await h.call('ana', 'POST', `/api/issues/${issue}/transition`, { to: 'resolution_submitted', note: '' });
    expect(noNote.status).toBe(422);
    const submitted = await h.call('ana', 'POST', `/api/issues/${issue}/transition`, { to: 'resolution_submitted', note: 'Roof patched, area dry.' });
    expect(submitted.status).toBe(200);
    const selfVerify = await h.call('ana', 'POST', `/api/issues/${issue}/transition`, { to: 'resolved', note: 'I checked it myself' });
    expect(selfVerify.status).toBe(403);
    const verified = await h.call('manager', 'POST', `/api/issues/${issue}/transition`, { to: 'resolved', note: 'Inspected with facilities, dry.' });
    expect(verified.status).toBe(200);
    const detail = await h.call('ana', 'GET', `/api/issues/${issue}`);
    expect(detail.body.issue.status).toBe('resolved');
    expect(detail.body.updates.map((u: any) => u.to_status).filter(Boolean)).toEqual(['open', 'resolution_submitted', 'resolved']);
  });

  it('rejects transitions the state machine does not allow', async () => {
    const res = await h.call('manager', 'POST', `/api/issues/${approvedIssueIds[1]}/transition`, { to: 'resolved', note: 'skip ahead' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invalid_transition');
  });

  it('records an audit trail for the report', async () => {
    const res = await h.call('manager', 'GET', `/api/audit?entity_type=shift_report&entity_id=${reportId}`);
    const actions = res.body.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['report.draft_created', 'report.submitted', 'analysis.completed', 'report.approved']));
    await expect(h.sql('delete from public.audit_logs')).rejects.toThrow(/SH:immutable/);
  });

  it('does not give administrators report content', async () => {
    expect((await h.sqlAs('admin', 'select * from public.shift_reports')).length).toBe(0);
    expect((await h.sqlAs('admin', 'select * from public.report_revisions')).length).toBe(0);
    expect((await h.sqlAs('admin', 'select * from public.ai_analysis_runs')).length).toBe(0);
    await expect(h.sqlAs('admin', 'select * from internal.analysis_inputs')).rejects.toThrow(/permission denied/);
    const overview = await h.call('admin', 'GET', '/api/admin/integrations');
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.body)).not.toContain('Forklift FL-02 brakes still soft');
  });

  it('hides colleagues’ email and phone at the column level', async () => {
    await expect(h.sqlAs('ana', 'select email from public.profiles')).rejects.toThrow(/permission denied/);
    expect((await h.sqlAs('ana', 'select full_name from public.profiles')).length).toBeGreaterThan(1);
  });
});

describe('revision and rejection', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => h?.close());

  it('lets the employee revise after a revision request, then the manager rejects', async () => {
    const shift = await demoOutgoingShift(h);
    const { body } = await h.call('juan', 'POST', `/api/shifts/${shift}/report`);
    const id = body.report_id;
    await h.call('juan', 'POST', `/api/reports/${id}/submit`, { content: { ...DEMO_SAMPLE_REPORT, handover_notes: 'All good.' } });
    await h.drain();
    const rev = await h.call('manager', 'POST', `/api/manager/reports/${id}/decision`, { decision: 'revision_requested', note: 'Add the PO numbers for the pallets.' });
    expect(rev.body.status).toBe('revision_requested');
    const mine = await h.call('juan', 'GET', `/api/reports/${id}`);
    expect(mine.body.decisions[0]).toMatchObject({ decision: 'revision_requested', note: 'Add the PO numbers for the pallets.' });
    const saved = await h.call('juan', 'PUT', `/api/reports/${id}/draft`, { content: { ...DEMO_SAMPLE_REPORT, handover_notes: 'PO 77812.' } });
    expect(saved.status).toBe(200);
    const resubmit = await h.call('juan', 'POST', `/api/reports/${id}/submit`, { content: { ...DEMO_SAMPLE_REPORT, handover_notes: 'PO 77812.' } });
    expect(resubmit.body.revision_no).toBe(2);
    await h.drain();
    const rejected = await h.call('manager', 'POST', `/api/manager/reports/${id}/decision`, { decision: 'rejected', note: 'Duplicate of another report.' });
    expect(rejected.body.status).toBe('rejected');
    const notes = await h.call('juan', 'GET', '/api/notifications');
    expect(notes.body.items.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['revision_requested', 'report_rejected']));
    expect((await h.sql('select count(*)::int as n from public.handover_deliveries where report_id = $1', [id]))[0].n).toBe(0);
  });
});

describe('reporting windows', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
    // Keep this suite focused on reporting-window behavior; Ben's seeded demo shift
    // would intentionally overlap the ad-hoc windows below and trigger the roster guard.
    const assignments = await h.sql(
      `select a.shift_id from public.shift_assignments a join public.shifts s on s.id = a.shift_id
       where a.employee_id = $1 and a.removed_at is null and s.status = 'scheduled'`,
      [h.ids.ben],
    );
    for (const assignment of assignments) {
      await h.call('manager', 'DELETE', `/api/manager/schedule/${assignment.shift_id}/assignments/${h.ids.ben}`);
    }
  });
  afterAll(async () => h?.close());

  it('refuses to open a report before the shift starts', async () => {
    const shift = await adhocShift(h, { startsSql: `now() + interval '3 hours'`, endsSql: `now() + interval '11 hours'`, employee: 'ben' });
    const res = await h.call('ben', 'POST', `/api/shifts/${shift}/report`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('window_not_open');
    await h.call('manager', 'DELETE', `/api/manager/schedule/${shift}/assignments/${h.ids.ben}`);
  });

  it('allows an early draft but not an early final submission', async () => {
    const shift = await adhocShift(h, { startsSql: `now() - interval '1 hour'`, endsSql: `now() + interval '7 hours'`, employee: 'ben' });
    const { body } = await h.call('ben', 'POST', `/api/shifts/${shift}/report`);
    expect(body.report_id).toBeTruthy();
    const res = await h.call('ben', 'POST', `/api/reports/${body.report_id}/submit`, { content: DEMO_SAMPLE_REPORT });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('window_not_open');
    await h.call('manager', 'DELETE', `/api/manager/schedule/${shift}/assignments/${h.ids.ben}`);
  });

  it('closes the window after the grace period; a supervisor override allows a late submission', async () => {
    const shift = await adhocShift(h, { startsSql: `now() - interval '10 hours'`, endsSql: `now() - interval '2 hours'`, employee: 'ana', grace: 30 });
    const closed = await h.call('ana', 'POST', `/api/shifts/${shift}/report`);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('window_closed');
    const otherDept = await h.call('facmanager', 'POST', `/api/manager/shifts/${shift}/override`, { employee_id: h.ids.ana, minutes: 30, reason: 'Late' });
    expect(otherDept.status).toBe(403);
    const ok = await h.call('manager', 'POST', `/api/manager/shifts/${shift}/override`, { employee_id: h.ids.ana, minutes: 30, reason: 'Radio outage at end of shift' });
    expect(ok.status).toBe(201);
    const { body } = await h.call('ana', 'POST', `/api/shifts/${shift}/report`);
    const submitted = await h.call('ana', 'POST', `/api/reports/${body.report_id}/submit`, { content: DEMO_SAMPLE_REPORT });
    expect(submitted.status).toBe(201);
    expect(submitted.body.is_late).toBe(true);
  });

  it('refuses employees who are not assigned to the shift', async () => {
    const shift = await demoOutgoingShift(h);
    const res = await h.call('ben', 'POST', `/api/shifts/${shift}/report`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_assigned');
  });

  it('refuses a reassigned employee', async () => {
    const shift = await adhocShift(h, { startsSql: `now() - interval '8 hours'`, endsSql: `now() + interval '10 minutes'`, employee: 'ben' });
    const removed = await h.call('manager', 'DELETE', `/api/manager/schedule/${shift}/assignments/${h.ids.ben}`);
    expect(removed.status).toBe(200);
    const res = await h.call('ben', 'POST', `/api/shifts/${shift}/report`);
    expect(res.body.error.code).toBe('not_assigned');
  });

  it('lets the supervisor, and only the supervisor, manage the schedule', async () => {
    const shift = {
      label: 'Cover shift',
      starts_at: new Date(Date.now() + 10 * 86400e3).toISOString(),
      ends_at: new Date(Date.now() + 10 * 86400e3 + 8 * 3600e3).toISOString(),
    };
    expect((await h.call('admin', 'POST', '/api/manager/schedule', shift)).status).toBe(403);
    expect((await h.call('juan', 'POST', '/api/manager/schedule', shift)).status).toBe(403);
    const created = await h.call('manager', 'POST', '/api/manager/schedule', shift);
    expect(created.status).toBe(201);
    // A supervisor of another department cannot staff or change this department's shifts.
    expect((await h.call('facmanager', 'POST', `/api/manager/schedule/${created.body.id}/assignments`, { employee_id: h.ids.liza })).status).toBe(403);
    expect((await h.call('facmanager', 'PATCH', `/api/manager/schedule/${created.body.id}`, { supervisor_id: null, status: 'cancelled' })).status).toBe(403);
    await expect(
      h.sqlAs('admin', `select app.assign_to_shift($1, $2)`, [created.body.id, h.ids.ben]),
    ).rejects.toThrow(/SH:forbidden/);
    // Only workers of this department can be put on its shifts.
    expect((await h.call('manager', 'POST', `/api/manager/schedule/${created.body.id}/assignments`, { employee_id: h.ids.liza })).status).toBe(422);
    expect((await h.call('manager', 'POST', `/api/manager/schedule/${created.body.id}/assignments`, { employee_id: h.ids.ben })).status).toBe(201);
    const overlap = await h.call('manager', 'POST', '/api/manager/schedule', {
      label: 'Overlapping cover',
      starts_at: new Date(new Date(shift.starts_at).getTime() + 3600e3).toISOString(),
      ends_at: new Date(new Date(shift.ends_at).getTime() + 3600e3).toISOString(),
    });
    const overlapAssignment = await h.call('manager', 'POST', `/api/manager/schedule/${overlap.body.id}/assignments`, { employee_id: h.ids.ben });
    expect(overlapAssignment.status).toBe(409);
    expect(overlapAssignment.body.error.code).toBe('conflict');
    const list = await h.call('facmanager', 'GET', `/api/manager/schedule?from=2026-01-01&to=2030-01-01`);
    expect(list.body.some((s: { id: string }) => s.id === created.body.id)).toBe(false);
  });

  it('stores operating hours and generates a shift pattern only on its selected weekdays', async () => {
    expect((await h.call('juan', 'POST', '/api/manager/schedule/preset', { preset: 'warehouse_extended' })).status).toBe(403);
    expect((await h.call('manager', 'POST', '/api/manager/schedule/preset', { preset: 'warehouse_extended' })).status).toBe(200);
    const warehousePatterns = await h.call('manager', 'GET', '/api/manager/templates');
    expect(warehousePatterns.body.filter((item: { is_active: boolean }) => item.is_active).map((item: { name: string }) => item.name)).toEqual([
      'Opening', 'Mid', 'Closing',
    ]);
    expect((await h.call('juan', 'PATCH', '/api/manager/schedule/settings', {
      operating_start_time: '07:00', operating_end_time: '22:00', operates_24_hours: false,
    })).status).toBe(403);
    expect((await h.call('manager', 'PATCH', '/api/manager/schedule/settings', {
      operating_start_time: '07:00', operating_end_time: '22:00', operates_24_hours: false,
    })).status).toBe(200);
    const settings = await h.call('manager', 'GET', '/api/manager/schedule/settings');
    expect(settings.body).toMatchObject({
      operating_start_time: '07:00', operating_end_time: '22:00', operates_24_hours: false,
    });

    const pattern = await h.call('manager', 'POST', '/api/manager/templates', {
      team_id: null,
      name: 'Alternating opening',
      start_time: '07:00',
      end_time: '15:00',
      window_open_minutes: 30,
      grace_minutes: 30,
      weekdays: [1, 3, 5],
    });
    expect(pattern.status).toBe(201);
    const generated = await h.call('manager', 'POST', `/api/manager/templates/${pattern.body.id}/generate`, {
      from: '2026-11-02', to: '2026-11-08', supervisor_id: h.ids.manager,
    });
    expect(generated.body.created).toBe(3);
    const dates = await h.sql<{ shift_date: string }>(
      `select shift_date::text as shift_date from public.shifts where template_id = $1 order by shift_date`,
      [pattern.body.id],
    );
    expect(dates.map((row) => row.shift_date)).toEqual(['2026-11-02', '2026-11-04', '2026-11-06']);
  });

  it('generates overnight shifts that end the next local day', async () => {
    const template = await h.call('manager', 'POST', '/api/manager/templates', {
      team_id: null, name: 'Local overnight', start_time: '22:00', end_time: '06:00',
      window_open_minutes: 30, grace_minutes: 30, weekdays: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(template.status).toBe(201);
    expect((await h.call('manager', 'POST', `/api/manager/templates/${template.body.id}/generate`, {
      from: '2026-12-01', to: '2026-12-01', supervisor_id: h.ids.manager,
    })).body.created).toBe(1);
    const [s] = await h.sql<{ starts: string; ends: string; hours: number; date: string }>(
      `select to_char(starts_at at time zone timezone, 'YYYY-MM-DD HH24:MI') as starts,
              to_char(ends_at at time zone timezone, 'YYYY-MM-DD HH24:MI') as ends,
              extract(epoch from ends_at - starts_at) / 3600 as hours, shift_date::text as date
         from public.shifts where template_id = $1`,
      [template.body.id],
    );
    expect(Number(s!.hours)).toBe(8);
    expect(s!.starts).toBe(`${s!.date} 22:00`);
    const next = new Date(`${s!.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    expect(s!.ends).toBe(`${next.toISOString().slice(0, 10)} 06:00`);
  });

  it('handles daylight-saving time zones', async () => {
    // The administrator sets up the department and its supervisor; the supervisor builds the schedule.
    const dept = await h.call('admin', 'POST', '/api/admin/departments', { code: 'NYC', name: 'New York Depot', timezone: 'America/New_York' });
    expect(dept.status).toBe(201);
    const user = await h.call('admin', 'POST', '/api/admin/users', {
      full_name: 'Nora York', email: 'nora.york@demo.test', password: 'test-password-123', role: 'manager', department_id: dept.body.id,
    });
    expect(user.status).toBe(201);
    await h.loginAs('nyc', 'nora.york@demo.test', 'test-password-123');
    const tpl = await h.call('nyc', 'POST', '/api/manager/templates', {
      team_id: null, name: 'Night', start_time: '22:00', end_time: '06:00', window_open_minutes: 30, grace_minutes: 30,
    });
    expect(tpl.status).toBe(201);
    const gen = await h.call('nyc', 'POST', `/api/manager/templates/${tpl.body.id}/generate`, { from: '2026-03-07', to: '2026-03-08', supervisor_id: null });
    expect(gen.body.created).toBe(2);
    const rows = await h.sql<{ d: string; hours: number }>(
      `select shift_date::text as d, extract(epoch from ends_at - starts_at) / 3600 as hours from public.shifts where template_id = $1 order by shift_date`,
      [tpl.body.id],
    );
    // Clocks spring forward at 2 AM on 8 March 2026 in New York.
    expect(rows.map((r) => [r.d, Number(r.hours)])).toEqual([
      ['2026-03-07', 7],
      ['2026-03-08', 8],
    ]);
  });

  it('rejects an unknown time zone', async () => {
    const res = await h.call('admin', 'POST', '/api/admin/departments', { code: 'BAD', name: 'Bad Zone', timezone: 'Mars/Olympus' });
    expect(res.status).toBe(422);
  });
});

describe('next-shift checklist with photo proof', () => {
  let h: Harness;
  let reportId: string;
  let taskIds: string[] = [];
  let photoId: string;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  beforeAll(async () => {
    h = await setup();
    const shift = await demoOutgoingShift(h);
    reportId = (await h.call('juan', 'POST', `/api/shifts/${shift}/report`)).body.report_id;
  });
  afterAll(async () => h?.close());

  it('requires an answer about open problems, and accepts them one at a time', async () => {
    const empty = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, {
      content: { completed_work: 'Counted aisle 7', problems: [], no_pending_tasks: true },
    });
    expect(empty.status).toBe(422);
    expect(empty.body.error.fields.unresolved_issues).toBeTruthy();
    const blank = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, {
      content: { completed_work: 'Counted aisle 7', problems: [{ category: 'equipment', location: '', what: '' }], no_pending_tasks: true },
    });
    expect(blank.body.error.fields['problems.0.what']).toBeTruthy();
    const ok = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, { content: DEMO_SAMPLE_REPORT });
    expect(ok.status).toBe(201);
    await h.drain();
    const [input] = await h.sql('select sanitized_text from internal.analysis_inputs where report_id = $1', [reportId]);
    expect(input.sanitized_text).toContain('Safety hazard at Charging station: Leak sa roof');
    expect(input.sanitized_text).toContain('Equipment at Dock 3: Door sensor still stops halfway.');
  });

  it('turns every task for the next shift into a tracked checklist item on approval', async () => {
    const detail = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    const run = detail.body.runs[0];
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
      decision: 'approved',
      content: {
        summary: 'Forklift FL-02 tagged out; leak near the charging station; three tasks for the next shift.',
        completed_tasks: [],
        unresolved_issues: [{ title: 'Leak near charging station', description: '', severity: 'high', is_safety_concern: true, link_issue_id: null, initial_status: 'open' }],
        pending_actions: run.draft.pending_actions.map((p: { description: string }) => ({ description: p.description })),
        notes_for_incoming: '',
      },
      flag_resolutions: flagResolutionsFor(run.flags),
      note: '',
    });
    expect(res.body.status).toBe('delivered');
    const [approval] = await h.sql('select approved_content from public.handover_approvals where report_id = $1', [reportId]);
    taskIds = approval.approved_content.pending_actions.map((p: { issue_id: string }) => p.issue_id);
    expect(taskIds).toHaveLength(3);
    const tasks = await h.sql(`select kind, status, code from public.operational_issues where id = any($1)`, [taskIds]);
    expect(tasks.every((t: any) => t.kind === 'task' && t.status === 'open' && /^ISS-\d{6}$/.test(t.code))).toBe(true);
  });

  it('shows the incoming worker a checklist with live status', async () => {
    const [handover] = (await h.call('ana', 'GET', '/api/handovers/incoming')).body;
    for (const id of taskIds) expect(handover.checklist[id]).toMatchObject({ kind: 'task', status: 'open', photo_count: 0 });
    const problemId = handover.approved_content.unresolved_issues[0].issue_id;
    expect(handover.checklist[problemId]).toMatchObject({ kind: 'problem', is_safety: true });
  });

  it('lets the worker mark a task done with a photo, which only their department can see', async () => {
    const res = await h.call('ana', 'POST', `/api/issues/${taskIds[0]}/transition`, {
      to: 'resolution_submitted',
      note: 'Wrapped and labelled all 6 pallets.',
      photo: { content_type: 'image/png', data_base64: PNG },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolution_submitted' });
    photoId = res.body.photo_id;
    const own = await h.app.request(`/api/issue-photos/${photoId}`, { headers: { Authorization: `Bearer ${await h.token('ben')}` } });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await own.arrayBuffer()).toString('base64')).toBe(PNG);
    expect((await h.call('facmanager', 'GET', `/api/issue-photos/${photoId}`)).status).toBe(404);
    expect((await h.call('admin', 'GET', `/api/issue-photos/${photoId}`)).status).toBe(403);
    const detail = await h.call('manager', 'GET', `/api/issues/${taskIds[0]}`);
    const update = detail.body.updates.find((u: any) => u.to_status === 'resolution_submitted');
    expect(detail.body.photos).toEqual([expect.objectContaining({ id: photoId, update_id: update.id })]);
    await expect(h.sql(`delete from public.issue_photos where id = $1`, [photoId])).rejects.toThrow(/SH:immutable/);
  });

  it('rejects photos that are not images', async () => {
    const res = await h.call('ana', 'POST', `/api/issues/${taskIds[1]}/transition`, {
      to: 'resolution_submitted',
      note: 'Returned the pallet jack.',
      photo: { content_type: 'image/gif', data_base64: PNG },
    });
    expect(res.status).toBe(422);
  });

  it('counts as done only after the supervisor confirms it', async () => {
    const selfConfirm = await h.call('ana', 'POST', `/api/issues/${taskIds[0]}/transition`, { to: 'resolved', note: 'done' });
    expect(selfConfirm.status).toBe(403);
    const confirm = await h.call('manager', 'POST', `/api/issues/${taskIds[0]}/transition`, { to: 'resolved', note: 'Checked the photo and the dispatch log.' });
    expect(confirm.status).toBe(200);
    const [handover] = (await h.call('ana', 'GET', '/api/handovers/incoming')).body;
    expect(handover.checklist[taskIds[0]!]).toMatchObject({ status: 'resolved', photo_count: 1 });
    expect(handover.checklist[taskIds[1]!]).toMatchObject({ status: 'open' });
    const notes = await h.call('ana', 'GET', '/api/notifications');
    expect(notes.body.items.map((n: any) => n.kind)).toContain('issue_resolved');
  });
});

describe('handover routing with overlapping shifts', () => {
  let h: Harness;
  let outgoing: string;
  let incoming: string;
  let midCrew: string;
  let reportId: string;

  beforeAll(async () => {
    h = await setup();
    outgoing = await demoOutgoingShift(h);
    incoming = await demoIncomingShift(h);
  });
  afterAll(async () => h?.close());

  const incomingOf = async (shift: string) =>
    (await h.sql<{ label: string; shift_date: string }>(
      `select n.label, n.shift_date::text from public.shifts n where n.id in (select app.incoming_shifts($1)) order by n.starts_at`,
      [shift],
    )).map((s) => `${s.label} ${s.shift_date}`);

  const dayAndNext = async (label: string) => {
    const [day] = await h.sql<{ d: string }>(`select (max(shift_date) - 2)::text as d from public.shifts where label = $1`, [label]);
    const [next] = await h.sql<{ d: string }>(`select ($1::date + 1)::text as d`, [day!.d]);
    const shift = async (l: string) => (await h.sql(`select id from public.shifts where label = $1 and shift_date = $2::date`, [l, day!.d]))[0].id;
    return { day: day!.d, next: next!.d, shift };
  };

  it('hands Morning (6–2) to Afternoon (2–10), and Afternoon to the next Morning', async () => {
    const { day, next, shift } = await dayAndNext('Morning');
    expect(await incomingOf(await shift('Morning'))).toEqual([`Afternoon ${day}`]);
    expect(await incomingOf(await shift('Afternoon'))).toEqual([`Morning ${next}`]);
    // The seeded week already has its crew: Juan in the morning, Ana and Ben in the afternoon.
    const crew = await h.sql(
      `select s.label, array_agg(p.full_name order by p.full_name) as names from public.shifts s
         join public.shift_assignments a on a.shift_id = s.id and a.removed_at is null join public.profiles p on p.id = a.employee_id
        where s.shift_date = $1::date and s.template_id is not null group by s.label order by s.label`,
      [day],
    );
    expect(crew).toEqual([{ label: 'Afternoon', names: ['Ana Lim', 'Ben Torres'] }, { label: 'Morning', names: ['Juan Dela Cruz'] }]);
  });

  it('sends each pattern to every crew on duty when it ends, and the last one to the next morning', async () => {
    // Overlapping crews, as in a department using the extended warehouse preset.
    expect((await h.call('manager', 'POST', '/api/manager/schedule/preset', { preset: 'warehouse_extended' })).status).toBe(200);
    // Switching patterns clears the retired Morning/Afternoon shifts from now on, staffed or not.
    const [retired] = await h.sql(
      `select count(*) filter (where s.status = 'scheduled' and s.starts_at > now() and a.id is null)::int as empty_left,
              count(*) filter (where s.status = 'scheduled' and a.id is not null)::int as staffed_kept
         from public.shifts s left join public.shift_assignments a on a.shift_id = s.id and a.removed_at is null
        where s.label in ('Morning', 'Afternoon')`,
    );
    expect(retired).toEqual({ empty_left: 0, staffed_kept: 0 });
    await h.services.db.asUser(h.ids.manager!, async (q) => {
      const templates = await q.query<{ id: string }>(`select id from public.shift_templates where is_active and department_id = app.my_department()`);
      for (const t of templates) await q.query(`select app.generate_shifts($1, current_date + 20, current_date + 23, auth.uid())`, [t.id]);
    });
    const { day, next, shift } = await dayAndNext('Opening');
    expect(await incomingOf(await shift('Opening'))).toEqual([`Mid ${day}`, `Closing ${day}`]);
    expect(await incomingOf(await shift('Mid'))).toEqual([`Closing ${day}`]);
    expect(await incomingOf(await shift('Closing'))).toEqual([`Opening ${next}`]);
  });

  it('delivers an approved handover to every crew on duty, not only the next one to start', async () => {
    // Ana moves from the incoming crew to a mid crew that is already working at hand-off time.
    expect((await h.call('manager', 'DELETE', `/api/manager/schedule/${incoming}/assignments/${h.ids.ana}`)).status).toBe(200);
    midCrew = await h.services.db.asUser(h.ids.manager!, async (q) => {
      const [s] = await q.query<{ id: string }>(
        `select app.create_shift((select team_id from public.shifts where id = $1), 'Mid crew', now() - interval '2 hours', now() + interval '6 hours', 30, 30, null, true) as id`,
        [outgoing],
      );
      await q.query('select app.assign_to_shift($1, $2)', [s!.id, h.ids.ana]);
      return s!.id;
    });
    expect(await incomingOf(outgoing)).toHaveLength(2);

    reportId = (await h.call('juan', 'POST', `/api/shifts/${outgoing}/report`)).body.report_id;
    const submit = await h.call('juan', 'POST', `/api/reports/${reportId}/submit`, {
      content: { completed_work: 'Unloaded PO 77812.', unresolved_issues: 'Aisle 4 light is out.', pending_tasks: 'Recount Aisle 7.' },
    });
    expect(submit.status).toBe(201);
    await h.drain();

    const detail = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    expect(detail.body.incoming_shifts.map((s: any) => [s.label, s.assignees])).toEqual([
      ['Mid crew', ['Ana Lim']],
      ['Afternoon (demo)', ['Ben Torres']],
    ]);
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
      decision: 'approved',
      content: { summary: detail.body.runs[0].draft.summary, completed_tasks: [], unresolved_issues: [], pending_actions: [], notes_for_incoming: '' },
      flag_resolutions: flagResolutionsFor(detail.body.runs[0].flags),
      note: '',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'delivered', recipients: 2 });
    const deliveries = await h.sql(`select recipient_id, shift_id from public.handover_deliveries where report_id = $1 and revoked_at is null`, [reportId]);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        { recipient_id: h.ids.ana, shift_id: midCrew },
        { recipient_id: h.ids.ben, shift_id: incoming },
      ]),
    );
    expect((await h.call('ana', 'GET', '/api/handovers/incoming')).body).toHaveLength(1);
  });

  it('delivers to a worker added to an on-duty crew after approval', async () => {
    expect((await h.call('manager', 'DELETE', `/api/manager/schedule/${midCrew}/assignments/${h.ids.ana}`)).status).toBe(200);
    expect((await h.call('ana', 'GET', '/api/handovers/incoming')).body).toEqual([]);
    const again = await h.call('manager', 'POST', `/api/manager/schedule/${midCrew}/assignments`, { employee_id: h.ids.ana });
    expect(again.status).toBe(201);
    expect(again.body.handovers_delivered).toBe(1);
  });

  it('creates fresh demo shifts as often as the supervisor asks', async () => {
    const first = await h.call('manager', 'POST', '/api/manager/demo/timeline');
    expect(first.status).toBe(201);
    const second = await h.call('manager', 'POST', '/api/manager/demo/timeline');
    expect(second.status).toBe(201);
    const active = await h.sql(
      `select s.label from public.shift_assignments a join public.shifts s on s.id = a.shift_id
        where a.removed_at is null and s.status = 'scheduled' and s.label like '% (demo)' order by s.label`,
    );
    // Named after the department's own first two shifts (Opening and Mid after the preset switch above).
    expect(active.map((r: any) => r.label)).toEqual(['Mid (demo)', 'Mid (demo)', 'Opening (demo)']);
    expect((await h.call('juan', 'GET', '/api/employee/dashboard')).body.current_shift).toMatchObject({ id: second.body.outgoing, window_state: 'open' });
  });
});

describe('crew takeover: many workers leave, many arrive', () => {
  let h: Harness;
  let morning: string;
  let afternoon: string;
  let dockIssue: string;
  const taskIds: string[] = [];
  const PASSWORD = 'test-password-123';

  async function addWorker(key: string, name: string) {
    const [dept] = await h.sql<{ id: string }>(`select id from public.departments where code = 'WH'`);
    const email = `${key}@demo.test`;
    const res = await h.call('admin', 'POST', '/api/admin/users', { full_name: name, email, password: PASSWORD, role: 'employee', department_id: dept!.id });
    expect(res.status).toBe(201);
    h.ids[key] = (await h.sql<{ id: string }>('select id from public.profiles where email = $1', [email]))[0]!.id;
    await h.loginAs(key, email, PASSWORD);
  }

  async function submitAndApprove(who: string, shift: string, task: string) {
    const reportId = (await h.call(who, 'POST', `/api/shifts/${shift}/report`)).body.report_id;
    const submit = await h.call(who, 'POST', `/api/reports/${reportId}/submit`, {
      content: { completed_work: 'Picked and staged outbound orders.', unresolved_issues: 'Dock 3 door still stops halfway.', pending_tasks: task },
    });
    expect(submit.status).toBe(201);
    await h.drain();
    const detail = await h.call('manager', 'GET', `/api/manager/reports/${reportId}`);
    const res = await h.call('manager', 'POST', `/api/manager/reports/${reportId}/decision`, {
      decision: 'approved',
      content: {
        summary: detail.body.runs[0].draft.summary,
        completed_tasks: [],
        unresolved_issues: [
          { title: 'Dock 3 door sensor still stops halfway', description: '', severity: 'medium', is_safety_concern: false, link_issue_id: dockIssue, initial_status: 'open' },
        ],
        pending_actions: [{ description: task }],
        notes_for_incoming: '',
      },
      flag_resolutions: flagResolutionsFor(detail.body.runs[0].flags),
      note: '',
    });
    expect(res.status).toBe(200);
    return res.body;
  }

  const boardShift = async (who: string, shift: string) =>
    (await h.call(who, 'GET', '/api/handovers/board')).body.shifts.find((s: any) => s.id === shift);

  beforeAll(async () => {
    h = await setup();
    morning = await demoOutgoingShift(h);
    afternoon = await demoIncomingShift(h);
    dockIssue = (await h.sql<{ id: string }>(`select id from public.operational_issues where title like 'Dock 3 door%'`))[0]!.id;
    await addWorker('pedro', 'Pedro Ramos');
    await addWorker('carla', 'Carla Mendoza');
    // Morning crew: Juan and Pedro. Afternoon crew: Ana, Ben and Carla.
    expect((await h.call('manager', 'POST', `/api/manager/schedule/${morning}/assignments`, { employee_id: h.ids.pedro })).status).toBe(201);
    expect((await h.call('manager', 'POST', `/api/manager/schedule/${afternoon}/assignments`, { employee_id: h.ids.carla })).status).toBe(201);
  });
  afterAll(async () => h?.close());

  it('shows the afternoon crew who is handing over, before anything is approved', async () => {
    const shift = await boardShift('ana', afternoon);
    expect(shift.outgoing.map((o: any) => [o.employee_name, o.report_status])).toEqual([
      ['Juan Dela Cruz', 'not_started'],
      ['Pedro Ramos', 'not_started'],
    ]);
    expect(shift.handovers).toEqual([]);
  });

  it('gives every afternoon worker every morning handover, with one combined checklist', async () => {
    expect(await submitAndApprove('juan', morning, 'Wrap 6 pallets for Northstar')).toMatchObject({ status: 'delivered', recipients: 3 });
    // Pedro's report is still waiting: the crew sees that it is on the way, but not its content.
    const pedroReport = (await h.call('pedro', 'POST', `/api/shifts/${morning}/report`)).body.report_id;
    await h.call('pedro', 'PUT', `/api/reports/${pedroReport}/draft`, { content: { completed_work: 'Secret draft text' } });
    const waiting = await boardShift('ben', afternoon);
    expect(waiting.outgoing.map((o: any) => o.report_status)).toEqual(['delivered', 'draft']);
    expect(JSON.stringify(waiting)).not.toContain('Secret draft text');

    expect(await submitAndApprove('pedro', morning, 'Recount Aisle 7')).toMatchObject({ status: 'delivered', recipients: 3 });
    for (const who of ['ana', 'ben', 'carla']) {
      const shift = await boardShift(who, afternoon);
      expect(shift.handovers.map((d: any) => d.outgoing_employee).sort()).toEqual(['Juan Dela Cruz', 'Pedro Ramos']);
      expect(shift.outgoing.every((o: any) => o.report_status === 'delivered')).toBe(true);
      // Both reported the Dock 3 door: it appears once, credited to both.
      const dock = shift.checklist.filter((i: any) => i.id === dockIssue);
      expect(dock).toHaveLength(1);
      expect(dock[0].from).toEqual(['Juan Dela Cruz', 'Pedro Ramos']);
      expect(shift.checklist).toHaveLength(3);
    }
    const shift = await boardShift('ana', afternoon);
    taskIds.push(...shift.checklist.filter((i: any) => i.kind === 'task').map((i: any) => i.id));
    expect(taskIds).toHaveLength(2);
  });

  it('lets one worker take an item so nobody else doubles up on it', async () => {
    const take = await h.call('ana', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: true });
    expect(take.status).toBe(200);
    expect(take.body).toMatchObject({ owner_id: h.ids.ana, status: 'in_progress' });
    const clash = await h.call('ben', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: true });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain('Ana Lim already took this');
    expect((await h.call('ben', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: false })).status).toBe(403);
    const item = (await boardShift('carla', afternoon)).checklist.find((i: any) => i.id === taskIds[0]);
    expect(item).toMatchObject({ owner_name: 'Ana Lim', status: 'in_progress' });
    expect((await h.call('manager', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: true })).status).toBe(403);
  });

  it('puts an item back for anyone when its owner lets go', async () => {
    const release = await h.call('ana', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: false });
    expect(release.body).toMatchObject({ owner_id: null, status: 'open' });
    expect((await h.call('ben', 'POST', `/api/issues/${taskIds[0]}/claim`, { take: true })).status).toBe(200);
  });

  it('shows the supervisor who is on duty now and who took what', async () => {
    const board = (await h.call('manager', 'GET', '/api/manager/shift-board')).body;
    const out = board.shifts.find((s: any) => s.id === morning);
    const inc = board.shifts.find((s: any) => s.id === afternoon);
    expect(out).toMatchObject({ phase: 'active' });
    expect(out.assignees.map((a: any) => [a.employee_name, a.report_status])).toEqual([
      ['Juan Dela Cruz', 'delivered'],
      ['Pedro Ramos', 'delivered'],
    ]);
    expect(inc).toMatchObject({ phase: 'upcoming' });
    expect(Object.fromEntries(inc.assignees.map((a: any) => [a.employee_name, a.items_taken]))).toMatchObject({ 'Ben Torres': 1, 'Ana Lim': 0 });
    expect(inc.assignees.every((a: any) => a.incoming_delivery.length === 2)).toBe(true);
    expect(board.counts).toMatchObject({ pending_review: 0 });
    // Cancelled shifts are left out of the day, and so is tomorrow (days end at midnight in Manila).
    expect(board.shifts.every((s: any) => s.status === 'scheduled')).toBe(true);
    const midnight = new Date(`${board.today}T00:00:00+08:00`).getTime() + 86400e3;
    expect(board.shifts.every((s: any) => new Date(s.starts_at).getTime() < midnight)).toBe(true);
    const tomorrow = new Date(midnight + 12 * 3600e3).toISOString().slice(0, 10);
    const next = (await h.call('manager', 'GET', `/api/manager/shift-board?date=${tomorrow}`)).body;
    expect(next.shifts.filter((s: any) => s.template_id).map((s: any) => s.label)).toEqual(['Morning', 'Afternoon']);
    expect((await h.call('juan', 'GET', '/api/manager/shift-board')).status).toBe(403);
  });

  it('sends a late approval to the crew on duty now, not to a crew that already went home', async () => {
    await addWorker('eli', 'Eli Santos');
    await addWorker('fay', 'Fay Cruz');
    await addWorker('gia', 'Gia Torres');
    const [dept] = await h.sql<{ id: string }>(`select id from public.departments where code = 'WH'`);
    const team = (await h.call('admin', 'POST', `/api/admin/departments/${dept!.id}/teams`, { name: 'Late approvals' })).body.id;
    const make = (label: string, starts: string, ends: string, grace: number, who: string) =>
      h.services.db.asUser(h.ids.manager!, async (q) => {
        const [s] = await q.query<{ id: string }>(`select app.create_shift($1, $2, ${starts}, ${ends}, 30, $3, null, true) as id`, [team, label, grace]);
        await q.query('select app.assign_to_shift($1, $2)', [s!.id, h.ids[who]]);
        return s!.id;
      });
    const early = await make('Early', `now() - interval '10 hours'`, `now() - interval '2 hours'`, 180, 'eli');
    const gone = await make('Gone home', `now() - interval '2 hours'`, `now() - interval '1 hour'`, 30, 'fay');
    const onDuty = await make('On duty', `now() - interval '30 minutes'`, `now() + interval '7 hours'`, 30, 'gia');
    expect((await h.sql('select x::text from app.incoming_shifts($1) x', [early])).map((r: any) => r.x)).toEqual([gone]);
    expect((await h.sql('select x::text from app.receiving_shifts($1) x', [early])).map((r: any) => r.x)).toEqual([onDuty]);

    expect(await submitAndApprove('eli', early, 'Sweep Bay 2')).toMatchObject({ status: 'delivered', recipients: 1 });
    expect((await h.call('gia', 'GET', '/api/handovers/incoming')).body).toHaveLength(1);
    expect((await h.call('fay', 'GET', '/api/handovers/incoming')).body).toEqual([]);
  });
});

describe("each supervisor sets their own department's shifts", () => {
  let h: Harness;
  let day: { id: string } & Record<string, unknown>;
  const body = (over: Record<string, unknown> = {}) => ({
    team_id: null, name: 'Day', start_time: '07:00', end_time: '19:00', window_open_minutes: 30, grace_minutes: 30,
    allow_early_draft: true, is_active: true, weekdays: [1, 2, 3, 4, 5, 6, 7], ...over,
  });
  const dayShifts = () =>
    h.sql<{ status: string; future: boolean; ended: boolean; staffed: boolean; starts: string }>(
      `select s.status, s.starts_at > now() as future, s.ends_at <= now() as ended,
              exists (select 1 from public.shift_assignments a where a.shift_id = s.id and a.removed_at is null) as staffed,
              to_char(s.starts_at at time zone s.timezone, 'HH24:MI') as starts
         from public.shifts s where s.template_id = $1 order by s.starts_at`,
      [day.id],
    );

  beforeAll(async () => {
    h = await setup();
    // Facilities runs one 7 AM – 7 PM "Day" shift; Liza works today's.
    day = (await h.call('facmanager', 'GET', '/api/manager/templates')).body.find((t: any) => t.name === 'Day');
  });
  afterAll(async () => h?.close());

  it('keeps one department’s shifts out of another supervisor’s hands', async () => {
    expect((await h.call('manager', 'PATCH', `/api/manager/templates/${day.id}`, body({ is_active: false }))).status).toBe(404);
    expect((await h.call('liza', 'PATCH', `/api/manager/templates/${day.id}`, body({ is_active: false }))).status).toBe(403);
  });

  it('moves upcoming shifts to new times instead of leaving the old ones beside them', async () => {
    const res = await h.call('facmanager', 'PATCH', `/api/manager/templates/${day.id}`, body({ start_time: '08:00', end_time: '16:00' }));
    expect(res.status).toBe(200);
    expect(res.body.moved).toBeGreaterThan(0);
    const future = (await dayShifts()).filter((s) => s.future);
    expect(future.every((s) => s.starts === '08:00')).toBe(true);
  });

  it('lets the supervisor add a shift of their own', async () => {
    const created = await h.call('facmanager', 'POST', '/api/manager/templates', body({ name: 'Late', start_time: '16:00', end_time: '00:00' }));
    expect(created.status).toBe(201);
    const names = (await h.call('facmanager', 'GET', '/api/manager/templates')).body.filter((t: any) => t.is_active).map((t: any) => t.name);
    expect(names).toEqual(['Day', 'Late']);
  });

  it('takes a removed shift off the schedule, even when it is staffed or running', async () => {
    const res = await h.call('facmanager', 'PATCH', `/api/manager/templates/${day.id}`, body({ start_time: '08:00', end_time: '16:00', is_active: false }));
    expect(res.body.cancelled).toBeGreaterThan(0);
    const shifts = await dayShifts();
    // Nothing still to come or in progress; only finished shifts someone worked stay as history.
    expect(shifts.filter((s) => !s.ended && s.status === 'scheduled')).toEqual([]);
    expect(shifts.filter((s) => s.status === 'scheduled').every((s) => s.ended && s.staffed)).toBe(true);
    expect((await h.call('liza', 'GET', '/api/employee/dashboard')).body.upcoming.some((s: any) => s.label === 'Day')).toBe(false);
  });

  it('brings the upcoming shifts back when the shift is added again', async () => {
    await h.call('facmanager', 'PATCH', `/api/manager/templates/${day.id}`, body({ start_time: '08:00', end_time: '16:00' }));
    const future = (await dayShifts()).filter((s) => s.future);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((s) => s.status === 'scheduled')).toBe(true);
  });
});

describe('starting the local demo over', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => h?.close());

  it('only lets an administrator clear it, and only with confirmation', async () => {
    expect((await h.call('manager', 'POST', '/api/admin/demo/clear', { confirm: 'CLEAR' })).status).toBe(403);
    expect((await h.call('admin', 'POST', '/api/admin/demo/clear', {})).status).toBe(422);
  });

  it('removes shifts, reports and tickets but keeps accounts and setup', async () => {
    const count = async () =>
      (await h.sql(
        `select (select count(*)::int from public.shifts) as shifts, (select count(*)::int from public.operational_issues) as issues,
                (select count(*)::int from public.shift_reports) as reports, (select count(*)::int from public.notifications) as notifications,
                (select count(*)::int from public.profiles) as profiles, (select count(*)::int from public.shift_templates where is_active) as patterns,
                (select count(*)::int from public.operational_records) as records`,
      ))[0];
    const before = await count();
    const draft = (await h.call('juan', 'POST', `/api/shifts/${await demoOutgoingShift(h)}/report`)).body.report_id;
    expect(draft).toBeTruthy();
    const res = await h.call('admin', 'POST', '/api/admin/demo/clear', { confirm: 'CLEAR' });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toMatchObject({ shifts: before.shifts, issues: before.issues, reports: 1 });
    expect(await count()).toEqual({ ...before, shifts: 0, issues: 0, reports: 0, notifications: 0 });
    const [audit] = await h.sql(`select actor_id, details from public.audit_logs where action = 'demo.cleared'`);
    expect(audit.actor_id).toBe(h.ids.admin);
    // Everything still works from the clean slate.
    expect((await h.call('juan', 'GET', '/api/employee/dashboard')).body.current_shift).toBeNull();
    expect((await h.call('manager', 'GET', '/api/manager/shift-board')).body.shifts).toEqual([]);
    expect((await h.call('manager', 'POST', '/api/manager/demo/timeline')).status).toBe(201);
  });
});
