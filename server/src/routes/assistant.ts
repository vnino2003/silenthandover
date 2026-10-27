import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AssistantState, AssistantContext, DepartmentExperience, assistantMissing, renderMicaSystem, renderMicaUser, ReportDraftContent, ReportSubmission, type AssistantView } from '@sh/shared';
import { asUser, idParam, parseBody, requireRole, svc, type AppEnv, type Ctx } from '../http/context';
import { leaveDates } from '../automation/mica-dates';
import { detectInjection } from '../automation/injection';
import { ApiError, fromZodError } from '../http/errors';
import { callWithFallback } from '../automation/ai-provider';
import { guidedReply, nextQuestion } from '../automation/assistant';
import { REDACTED, REDACTION_NOTICE, restoreDeep, safePreparationOutput, sanitizeTogether, stripFences } from '../automation/mica';

interface Proposal {
  id: string; employee_id: string; shift_id: string | null; state: AssistantState; version: number;
  engine: string; reply: string; expires_at: Date; result: AssistantView['result'];
}
function view(p: Proposal): AssistantView {
  const missing = assistantMissing(p.state);
  if (p.state.intent === 'report' && !p.shift_id) missing.push('Select an assigned shift before preparing a report');
  return { id: p.id, version: p.version, state: p.state, engine: p.engine, reply: p.reply,
    missing, ready: !missing.length && !p.result && p.state.intent !== 'leave', shift_id: p.shift_id, expires_at: new Date(p.expires_at).toISOString(), result: p.result };
}
async function load(c: Ctx, id: string) {
  const [row] = await svc(c).db.asService((q) => q.query<Proposal>(
    'select * from internal.assistant_proposals where id = $1 and employee_id = $2', [id, c.get('userId')],
  ));
  if (!row) throw new ApiError(404, 'not_found', 'Preparation not found');
  return row;
}
function editable(p: Proposal, version: number) {
  if (p.version !== version) throw new ApiError(409, 'conflict', 'This preparation changed. Reload the latest summary.');
  if (p.result) throw new ApiError(409, 'conflict', 'This action has already been confirmed. Start a new conversation.');
  if (new Date(p.expires_at).getTime() <= Date.now()) throw new ApiError(409, 'conflict', 'This preparation expired. Start a new conversation.');
}
async function checkIssue(c: Ctx, s: AssistantState) {
  if (s.intent === 'report' && s.content.issue_updates.length) {
    const ids = s.content.issue_updates.map((i) => i.issue_id);
    const rows = await asUser(c, (q) => q.query('select id from public.operational_issues where id = any($1::uuid[]) and department_id = app.my_department()', [ids]));
    if (new Set(ids).size !== ids.length || rows.length !== ids.length) throw new ApiError(422, 'validation', 'Use each department issue only once');
  }
  if (s.intent !== 'task_update' || !s.issue_code) return;
  const rows = await asUser(c, (q) => q.query('select id from public.operational_issues where code = $1 and department_id = app.my_department()', [s.issue_code]));
  if (!rows.length) throw new ApiError(422, 'validation', 'Choose an existing issue code from your department');
}

export function assistantRoutes() {
  const r = new Hono<AppEnv>();
  r.use('/assistant/*', async (c, next) => { requireRole(c, 'employee'); c.header('Cache-Control', 'no-store'); await next(); });
  r.use('/assistant/*', bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new ApiError(413, 'too_large', 'Keep this request under 64 KB'); } }));

  r.get('/assistant/status', async (c) => c.json(await asUser(c, async (q) => ({
    reports: await q.query(`select id, reference_code, status, last_submitted_at from public.shift_reports
      where employee_id = auth.uid() order by updated_at desc limit 10`),
    issues: await q.query(`select id, code, title, status from public.operational_issues
      where department_id = app.my_department() order by last_activity_at desc limit 20`),
    checked_at: new Date().toISOString(),
  }))));

  r.get('/assistant/preparations/:id', async (c) => c.json(view(await load(c, idParam(c)))));

  r.post('/assistant/message', async (c) => {
    const body = await parseBody(c, z.strictObject({
      message: z.string().trim().min(1).max(6000),
      preparation_id: z.uuid().optional(), version: z.number().int().positive().optional(), shift_id: z.uuid().nullable().optional(),
      context: AssistantContext.optional(),
    }));
    const services = svc(c);
    let previous = AssistantState.parse({});
    let p: Proposal | null = null;
    let base: { id: string; updated_at: Date; draft_content: unknown } | undefined;
    let shiftId = body.shift_id ?? null;
    if (!body.preparation_id && body.context?.page === 'report' && body.context.entity_id) {
      const [owned] = await asUser(c,(q) => q.query<{shift_id:string}>('select shift_id from public.shift_reports where id=$1 and employee_id=auth.uid()',[body.context!.entity_id]));
      if (!owned) throw new ApiError(404,'not_found','Report not found');
      shiftId = owned.shift_id;
    }
    if (body.preparation_id) {
      p = await load(c, body.preparation_id);
      editable(p, body.version ?? -1);
      previous = p.state;
      shiftId = p.shift_id;
    } else if (shiftId) {
      await asUser(c, async (q) => {
        const rows = await q.query(`select s.id from public.shifts s join public.shift_assignments a on a.shift_id = s.id
          where s.id = $1 and a.employee_id = auth.uid() and a.removed_at is null and s.status = 'scheduled'`, [shiftId]);
        if (!rows.length) throw new ApiError(404, 'not_found', 'Assigned shift not found');
        [base] = await q.query<{ id: string; updated_at: Date; draft_content: unknown }>(
          'select id, updated_at, draft_content from public.shift_reports where shift_id = $1 and employee_id = auth.uid()', [shiftId]);
      });
      if (base) previous.content = ReportDraftContent.parse(base.draft_content);
    }

    const [department] = await asUser(c,(q) => q.query<{experience:unknown}>('select experience from public.departments where id=app.my_department()'));
    const experience = DepartmentExperience.parse(department?.experience ?? {});
    let state: AssistantState;
    let engine = 'guided';
    let notice: string | undefined;
    let modelReply = '';
    const injection = detectInjection(body.message).length > 0;
    // A message that tries to steer the model is not sent to it; guided preparation keeps the employee's words.
    if (injection) notice = 'Embedded instructions cannot change permissions or skip review. This message was not sent to the AI; check the draft before confirming.';
    let active: Awaited<ReturnType<typeof services.aiSettings.active>>;
    try { active = await services.aiSettings.active(); }
    catch { active = null; engine = 'guided_unavailable'; notice = 'AI is unavailable. Continue with guided preparation or use the standard form.'; }
    const leaveIntent=previous.intent==='leave' || (previous.intent==='unsupported' && /\b(leave|time off)\b/i.test(body.message));
    if(leaveIntent && !injection){
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:c.get('profile').department_timezone ?? 'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const dates=leaveDates(body.message,today);
      const types=await asUser(c,q=>q.query<{name:string}>('select name from public.leave_types where is_active'));
      const type=types.find(t=>body.message.toLowerCase().includes(t.name.toLowerCase()))?.name ?? previous.leave.type;
      state=AssistantState.parse({...previous,intent:'leave',leave:{...previous.leave,type,...dates}});
      notice='Review dates and choose the leave type in the Leave form. Private reasons stay there.';
    } else if (active && !injection) {
      const { roster, codes } = await asUser(c, async (q) => ({
        roster: await q.query<{ full_name: string; pseudonym: string }>('select full_name, pseudonym from public.profiles where department_id = app.my_department()'),
        codes: await q.query<{ code: string }>('select code from public.operational_issues where department_id = app.my_department()'),
      }));
      // The draft and the message are sanitized together, so each person keeps one pseudonym.
      const safe = sanitizeTogether([JSON.stringify(previous), body.message], roster);
      const [safePrevious, safeMessage] = safe.parts as [string, string];
      const facts = JSON.stringify({ authorized_issue_codes: codes.map((i) => i.code), department_experience: experience });
      try {
        const shape = z.strictObject({ state: AssistantState, reply: z.string().trim().min(1).max(1200).optional() });
        const reply = await callWithFallback(services.aiSettings, services.fetchImpl, { ...active, model: active.automatic ? null : active.model }, {
          system: renderMicaSystem('prepare'),
          user: renderMicaUser({ role: 'employee', page: body.context?.page ?? 'assistant', facts, previousState: safePrevious, rawInput: safeMessage }),
          responseSchema: z.toJSONSchema(shape),
        }, Math.min(services.config.AI_REQUEST_TIMEOUT_MS, 30_000), 30_000);
        const parsed = shape.parse(JSON.parse(stripFences(reply.text)));
        if (!safePreparationOutput(JSON.stringify(parsed), safePrevious + safeMessage + facts)) throw new Error('ungrounded_output');
        // Unchanged text gets the employee's original back; new text gets the names back.
        state = AssistantState.parse(restoreDeep(parsed.state, previous, JSON.parse(safePrevious), safe.mapping));
        modelReply = restoreDeep(parsed.reply ?? '', undefined, undefined, safe.mapping);
        engine = active.provider;
        if (REDACTED.test(JSON.stringify(parsed.state)) && !REDACTED.test(JSON.stringify(previous))) notice = REDACTION_NOTICE;
      } catch {
        // Provider error bodies can echo prompts: never expose them or log employee content.
        state = guidedReply(body.message,previous);
        engine = 'guided_unavailable';
        notice = 'AI could not produce a valid answer. Continue with guided preparation; review the editable details.';
      }
    } else state = guidedReply(body.message, previous);
    await checkIssue(c, state);
    const reply = state.intent === 'status' ? 'Here is the latest status from your workplace records.' : modelReply || nextQuestion(state);
    const saved = await services.db.asService(async (q) => {
      if (p) {
        const [updated] = await q.query<Proposal>(`update internal.assistant_proposals set state = $1::jsonb, engine = $2, reply = $3, version = version + 1, ready = false
          where id = $4 and employee_id = $5 and version = $6 and result is null and expires_at > now() returning *`,
        [JSON.stringify(state), engine, reply, p.id, c.get('userId'), p.version]);
        if (!updated) throw new ApiError(409, 'conflict', 'This preparation changed. Reload the latest summary.');
        return updated;
      }
      await q.query('delete from internal.assistant_proposals where expires_at < now()');
      const [created] = await q.query<Proposal>(`insert into internal.assistant_proposals
        (employee_id, shift_id, base_report_id, base_report_updated_at, state, engine, reply)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning *`,
      [c.get('userId'), shiftId, base?.id ?? null, base?.updated_at ?? null, JSON.stringify(state), engine, reply]);
      return created!;
    });
    return c.json({...view(saved),...(notice ? {notices:[notice]} : {})});
  });

  // Edits update the server snapshot. Confirmation accepts no client-authored action payload.
  r.put('/assistant/preparations/:id', async (c) => {
    const p = await load(c, idParam(c));
    const body = await parseBody(c, z.strictObject({ version: z.number().int().positive(), state: AssistantState }));
    editable(p, body.version);
    await checkIssue(c, body.state);
    const [updated] = await svc(c).db.asService((q) => q.query<Proposal>(`update internal.assistant_proposals set state = $1::jsonb,
      reply = $2, version = version + 1, ready = $6 where id = $3 and employee_id = $4 and version = $5 and result is null and expires_at > now() returning *`,
    [JSON.stringify(body.state), nextQuestion(body.state), p.id, c.get('userId'), p.version, assistantMissing(body.state).length === 0 && body.state.intent !== 'leave' && (body.state.intent !== 'report' || Boolean(p.shift_id))]));
    if (!updated) throw new ApiError(409, 'conflict', 'This preparation changed. Reload the latest summary.');
    return c.json(view(updated));
  });

  r.post('/assistant/preparations/:id/draft', async (c) => {
    const p = await load(c,idParam(c));
    const body = await parseBody(c,z.strictObject({version:z.number().int().positive()}));
    if (!p.result) { editable(p,body.version); await checkIssue(c,p.state); }
    const [row] = await asUser(c,q=>q.query<{r:AssistantView['result']}>('select app.save_assistant_draft($1,$2) as r',[p.id,body.version]));
    return c.json({...view(p),ready:false,result:row!.r});
  });

  r.post('/assistant/preparations/:id/confirm', async (c) => {
    const p = await load(c, idParam(c));
    const body = await parseBody(c, z.strictObject({ version: z.number().int().positive(), confirmed: z.literal(true) }));
    if (p.state.intent === 'leave') throw new ApiError(422, 'validation', 'Leave requests are submitted on the Leave form. Use “Review dates in Leave”.');
    if (!p.result) {
      editable(p, body.version);
      if (view(p).missing.length) throw new ApiError(422, 'validation', 'Complete the missing information before confirming');
      if (p.state.intent === 'report') {
        const parsed = ReportSubmission.safeParse(p.state.content);
        if (!parsed.success) throw fromZodError(parsed.error);
        const ids = parsed.data.issue_updates.map((i) => i.issue_id);
        if (new Set(ids).size !== ids.length) throw new ApiError(422, 'validation', 'Each issue can be updated once per report');
        if (ids.length) {
          const rows = await asUser(c, (q) => q.query('select id from public.operational_issues where id = any($1::uuid[]) and department_id = app.my_department()', [ids]));
          if (rows.length !== ids.length) throw new ApiError(422, 'validation', 'Use only issues in your department');
        }
      }
    }
    const [result] = await asUser(c, (q) => q.query<{ r: AssistantView['result'] }>('select app.confirm_assistant($1, $2) as r', [p.id, body.version]));
    svc(c).kick();
    return c.json({ ...view(p), ready: false, result: result!.r });
  });
  return r;
}
