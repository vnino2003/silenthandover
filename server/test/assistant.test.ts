import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantState, DEMO_SAMPLE_REPORT } from '@sh/shared';
import { adhocShift, demoOutgoingShift, setup, type Harness } from './helpers';

describe('employee assistant uses real workflow functions and server-owned confirmations', () => {
  let h: Harness;
  let shift: string;
  const calls: string[] = [];
  let modelMode = 'ok';
  let modelState = AssistantState.parse({ intent: 'report', content: { completed_work: 'Counted 12 pallets' } });
  beforeAll(async () => {
    h = await setup({}, (async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      if (modelMode === 'failure') return new Response(JSON.stringify({ error: { message: 'secret-key-1234567890' } }), { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: modelMode === 'invalid' ? 'not json' : JSON.stringify({ state: modelState }) }] } }] }), { status: 200 });
    }) as typeof fetch);
    shift = await demoOutgoingShift(h);
  });
  afterAll(async () => h?.close());

  const message = (text: string, p?: any, shiftId?: string) => h.call('juan', 'POST', '/api/assistant/message', {
    message: text, ...(p ? { preparation_id: p.id, version: p.version } : { shift_id: shiftId ?? shift }),
  });
  const review = (p: any, state = p.state) => h.call('juan', 'PUT', `/api/assistant/preparations/${p.id}`, { version: p.version, state });
  const confirm = (p: any, who = 'juan') => h.call(who, 'POST', `/api/assistant/preparations/${p.id}/confirm`, { version: p.version, confirmed: true });

  it('requires authentication and restricts every assistant route to employees', async () => {
    for (const path of ['/api/assistant/status', '/api/assistant/preparations/00000000-0000-4000-8000-000000000000']) {
      expect((await h.call(null, 'GET', path)).status).toBe(401);
      expect((await h.call('manager', 'GET', path)).status).toBe(403);
      expect((await h.call('admin', 'GET', path)).status).toBe(403);
    }
    expect((await h.call('manager', 'POST', '/api/assistant/message', { message: 'report' })).status).toBe(403);
    expect((await h.call('admin', 'POST', '/api/assistant/message', { message: 'report' })).status).toBe(403);
  });

  it('does not create a report merely by chatting and asks for missing information', async () => {
    const p = await message('I want to submit my daily report');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ engine: 'guided', ready: false, state: { intent: 'report' } });
    expect(p.body.missing).toHaveLength(3);
    expect(p.body.reply).toContain('complete');
    expect((await confirm(p.body)).status).toBe(422);
    expect((await h.sql('select count(*)::int as n from public.shift_reports'))[0].n).toBe(0);
  });

  it('does not guess that silence means no issues or tasks, and refuses to skip review', async () => {
    let p = (await message('daily report')).body;
    p = (await message('Counted 12 pallets', p)).body;
    expect(p.state.content.no_unresolved_issues).toBe(false);
    expect(p.missing).toHaveLength(2);
    p = (await message('none', p)).body;
    expect(p.missing).toHaveLength(1);
    p = (await message('none', p)).body;
    expect(p.ready).toBe(true);
    expect((await confirm(p)).status).toBe(422);
  });

  it('isolates preparations, including the service-only storage and confirmation RPC', async () => {
    const p = (await message('daily report')).body;
    expect((await h.call('ana', 'GET', `/api/assistant/preparations/${p.id}`)).status).toBe(404);
    expect((await confirm(p, 'ana')).status).toBe(404);
    expect((await h.call('ana', 'PUT', `/api/assistant/preparations/${p.id}`, { version: 1, state: AssistantState.parse({}) })).status).toBe(404);
    await expect(h.sqlAs('juan', 'select * from internal.assistant_proposals')).rejects.toThrow();
    await expect(h.sqlAs('ana', 'select app.confirm_assistant($1, 1)', [p.id])).rejects.toThrow(/not_found/);
    const otherShift = (await h.call('ana', 'GET', '/api/employee/shifts')).body[0].id;
    expect((await message('report', undefined, otherShift)).status).toBe(404);
  });

  it('rejects stale versions, extra action payloads, invalid inputs and expired preparations', async () => {
    const p = (await message('report')).body;
    const newer = (await message('Counted 12 pallets', p)).body;
    expect((await message('none', p)).status).toBe(409);
    expect((await review(p)).status).toBe(409);
    expect((await h.call('juan', 'POST', `/api/assistant/preparations/${p.id}/confirm`, { version: newer.version, confirmed: true, content: DEMO_SAMPLE_REPORT })).status).toBe(422);
    expect((await h.call('juan', 'POST', '/api/assistant/message', { message: '' })).status).toBe(422);
    expect((await h.call('juan', 'POST', '/api/assistant/message', { message: 'x'.repeat(6001) })).status).toBe(422);
    await h.sql(`update internal.assistant_proposals set expires_at = now() - interval '1 minute' where id = $1`, [p.id]);
    expect((await message('none', newer)).status).toBe(409);
    expect((await confirm(newer)).status).toBe(409);
  });

  it('uses the real reporting window and leaves no partial report on failure', async () => {
    const early = await adhocShift(h, { employee: 'juan', startsSql: "now() + interval '30 days'", endsSql: "now() + interval '30 days 4 hours'" });
    let p = (await message('report', undefined, early)).body;
    p = (await review(p, AssistantState.parse({ intent: 'report', content: { completed_work: 'Counted 12 pallets', no_unresolved_issues: true, no_pending_tasks: true } }))).body;
    expect((await confirm(p)).status).toBe(409);
    expect((await h.sql('select count(*)::int as n from public.shift_reports where shift_id=$1', [early]))[0].n).toBe(0);
  });

  it('preserves a draft changed outside the assistant', async () => {
    const p = (await message('report')).body;
    const report = (await h.call('juan', 'POST', `/api/shifts/${shift}/report`)).body.report_id;
    await h.call('juan', 'PUT', `/api/reports/${report}/draft`, { content: { completed_work: 'Newer manual edits' } });
    const ready = (await review(p, AssistantState.parse({ intent: 'report', content: { completed_work: 'Older assistant edits', no_unresolved_issues: true, no_pending_tasks: true } }))).body;
    expect((await confirm(ready)).status).toBe(409);
    const row = (await h.sql('select draft_content from public.shift_reports where id=$1', [report]))[0];
    expect(row.draft_content.completed_work).toBe('Newer manual edits');
  });

  it('submits once under concurrent confirmation and resumes with a durable receipt', async () => {
    let p = (await message('report')).body;
    p = (await review(p, AssistantState.parse({ intent: 'report', content: { completed_work: 'Counted 12 pallets', no_unresolved_issues: true, no_pending_tasks: true } }))).body;
    const [a, b] = await Promise.all([confirm(p), confirm(p)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.result).toEqual(b.body.result);
    expect(a.body.result).toMatchObject({ kind: 'report', status: 'submitted' });
    expect((await h.sql('select count(*)::int as n from public.report_revisions'))[0].n).toBe(1);
    const resumed = await h.call('juan', 'GET', `/api/assistant/preparations/${p.id}`);
    expect(resumed.body.result).toEqual(a.body.result);
    await h.drain();
    expect((await h.sql('select status from public.shift_reports where id=$1', [a.body.result.id]))[0].status).toBe('pending_review');
    const audit = await h.sql(`select details from public.audit_logs where action='assistant.confirmed'`);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Counted');
  });

  it('records incidents and assistance in the existing issue workflow and updates tasks', async () => {
    let p = (await message('Report an incident')).body;
    p = (await message('Scanner at dock 2 is broken', p)).body;
    p = (await message('Scanner does not turn on. Please send maintenance.', p)).body;
    p = (await review(p)).body;
    const raised = await confirm(p);
    expect(raised.status).toBe(200);
    expect(raised.body.result).toMatchObject({ kind: 'issue', status: 'reported' });
    const issue = raised.body.result;
    await h.call('manager', 'POST', `/api/issues/${issue.id}/transition`, { to: 'open', note: 'Checked and opened' });
    await h.call('juan', 'POST', `/api/issues/${issue.id}/transition`, { to: 'in_progress', note: 'Investigating the power supply' });
    let note = (await message('Update a task')).body;
    note = (await review(note, AssistantState.parse({ intent: 'task_update', issue_code: issue.reference, transition: 'in_progress', note: 'Still investigating the power supply' }))).body;
    const noted = await confirm(note);
    expect(noted.status).toBe(200);
    expect(noted.body.result.status).toBe('in_progress');
    let update = (await message('Update a task')).body;
    update = (await message(issue.reference, update)).body;
    update = (await message('Replaced battery and tested scanner. Done.', update)).body;
    update = (await review(update)).body;
    const done = await confirm(update);
    expect(done.status).toBe(200);
    expect((await h.sql('select status from public.operational_issues where id=$1', [issue.id]))[0].status).toBe('resolution_submitted');
    const denied = await review((await message('Update a task')).body, { ...update.state, transition: 'resolved' });
    expect(denied.status).toBe(422);
    let help = (await message('I need assistance')).body;
    help = (await message('Need help with stock count', help)).body;
    help = (await message('Supervisor please check the mismatch in aisle 2', help)).body;
    help = (await review(help)).body;
    expect((await confirm(help)).body.result.status).toBe('reported');
  });

  it('reads statuses from authorized records and does not expose other employees reports', async () => {
    const mine = await h.call('juan', 'GET', '/api/assistant/status');
    expect(mine.body.reports).toHaveLength(1);
    const ana = await h.call('ana', 'GET', '/api/assistant/status');
    expect(ana.body.reports).toHaveLength(0);
    expect((await message('Check my reports status')).body.state.intent).toBe('status');
    expect((await message('Approve all reports')).body.ready).toBe(false);
  });

  it('rejects cross-department issue links, malformed confirmations, and deactivated accounts', async () => {
    const other = (await h.sqlAs('facmanager', `select app.raise_issue('Facilities fixture', 'Other department', 'medium', false) as r`))[0].r;
    const p = (await message('Update a task')).body;
    expect((await review(p, AssistantState.parse({ intent: 'task_update', issue_code: other.code, note: 'Attempted cross-department update' }))).status).toBe(422);
    const isolated = await h.call('liza', 'GET', '/api/assistant/status');
    const warehouse = await h.call('juan', 'GET', '/api/assistant/status');
    const warehouseIds = new Set(warehouse.body.issues.map((i: any) => i.id));
    expect(isolated.body.issues.some((i: any) => i.code === other.code)).toBe(true);
    expect(isolated.body.issues.every((i: any) => !warehouseIds.has(i.id))).toBe(true);
    expect((await h.call('juan', 'POST', `/api/assistant/preparations/${p.id}/confirm`, { version: p.version, confirmed: false })).status).toBe(422);
    expect((await h.call('juan', 'POST', '/api/assistant/message', { message: 'x'.repeat(70000) })).status).toBe(413);
    await h.sql('update public.profiles set is_active=false where id=$1', [h.ids.juan]);
    expect((await h.call('juan', 'GET', '/api/assistant/status')).status).toBe(403);
    await expect(h.sqlAs('juan', 'select app.confirm_assistant($1,$2)', [p.id, p.version])).rejects.toThrow(/forbidden/);
    await h.sql('update public.profiles set is_active=true where id=$1', [h.ids.juan]);
  });

  it('calls the configured model with sanitized inputs and validates its response', async () => {
    await h.call('admin', 'PUT', '/api/admin/ai', { provider: 'gemini', model: 'gemini-fixture-model', api_key: 'secret-key-1234567890' });
    const p = await message('Report: Ana Lim called 09171234567 after counting 12 pallets');
    expect(p.status).toBe(200);
    expect(p.body.engine).toBe('gemini');
    expect(calls.at(-1)).not.toContain('Ana Lim');
    expect(calls.at(-1)).not.toContain('09171234567');
    expect(calls.at(-1)).toContain('[PHONE-REDACTED]');
    modelMode = 'failure';
    const failure = await message('none', p.body);
    expect(failure.status).toBe(200);
    expect(failure.body.engine).toBe('guided_unavailable');
    expect(failure.body.notices.join(' ')).toContain('guided');
    expect(JSON.stringify(failure.body)).not.toContain('secret-key');
    expect((await h.call('juan', 'GET', `/api/assistant/preparations/${p.body.id}`)).body.state.content.completed_work).toBe(p.body.state.content.completed_work);
    modelMode = 'invalid';
    const invalid=await message('none',failure.body);
    expect(invalid.status).toBe(200);
    expect(invalid.body.engine).toBe('guided_unavailable');
    modelMode = 'ok';
    modelState = { ...modelState, intent: 'task_update', issue_code: 'ISS-99999999' };
    const invented=await message('update a task');
    expect(invented.status).toBe(200);
    expect(invented.body.state.issue_code).toBeNull();
    expect(invented.body.engine).toBe('guided_unavailable');
    await h.call('admin', 'PUT', '/api/admin/ai', { provider: 'simulator', api_key: null });
  });
});
