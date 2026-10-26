import { AiHandoverDraft, buildHandoverPrompt, ReportDraftContent, type PromptVersion, type RenderedPrompt } from '@sh/shared';
import type { Config } from '../config';
import type { Db, Queryable } from '../db/types';
import { AI_PROVIDERS, callProvider, type AiSettings } from './ai-provider';
import { simulateAnalysis } from './dev-analyzer';
import { groundDraft, type GroundingRecord } from './grounding';
import { detectInjection, type InjectionFinding } from './injection';
import { renderReportText } from './report-text';
import { sanitize } from './sanitize';

export interface AnalysisJob {
  eventId: string;
  attempt: number;
  idempotencyKey: string;
  reportId: string;
  reportRef: string;
  revision: number;
  prompt: RenderedPrompt;
  sanitizedText: string;
  openIssues: { code: string; title: string }[];
}

export interface CompletionMeta {
  engine: string;
  model?: string | null;
  isSimulated: boolean;
  latencyMs?: number | null;
  usage?: unknown;
}

export interface AnalysisAdapter {
  readonly name: 'dev' | 'n8n' | 'admin';
  dispatch(job: AnalysisJob, pipeline: AnalysisPipeline): Promise<void>;
  /** What actually runs right now (the admin adapter depends on the saved settings). */
  status?(): Promise<AnalysisStatus>;
}

export interface AnalysisStatus {
  adapter: 'dev' | 'n8n' | 'admin';
  provider: string | null;
  model: string | null;
  simulated: boolean;
}

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

interface EventRow {
  id: string;
  attempts: number;
  idempotency_key: string;
  report_id: string;
  revision_no: number;
}

export class AnalysisPipeline {
  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, 'PROMPT_VERSION'>,
    private readonly adapter: AnalysisAdapter,
    private readonly log: Logger = () => {},
  ) {}

  get adapterName() {
    return this.adapter.name;
  }

  async status(): Promise<AnalysisStatus> {
    return this.adapter.status?.() ?? { adapter: this.adapter.name, provider: null, model: null, simulated: this.adapter.name === 'dev' };
  }

  /** Claims due analysis events and dispatches them. Safe to call often. */
  async runDue(limit = 5): Promise<number> {
    const events = await this.db.asService((q) =>
      q.query<EventRow>('select id, attempts, idempotency_key, report_id, revision_no from internal.claim_analysis_events($1, $2)', [
        limit,
        this.adapter.name,
      ]),
    );
    for (const ev of events) {
      try {
        const job = await this.prepare(ev);
        await this.adapter.dispatch(job, this);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown dispatch error';
        this.log('analysis dispatch failed', { event: ev.id, attempt: ev.attempts, error: message });
        await this.recordFailure(ev.id, ev.attempts, 'failed', `Dispatch failed: ${message}`, null);
      }
    }
    return events.length;
  }

  /** Loads the revision, sanitizes it, stores what will be sent, and renders the bounded prompt. */
  private async prepare(ev: EventRow): Promise<AnalysisJob> {
    return this.db.asService(async (q) => {
      const [row] = await q.query<{ reference_code: string; department_id: string; content: unknown; label: string; shift_date: string; starts_at: Date; ends_at: Date }>(
        `select r.reference_code, r.department_id, v.content, s.label, s.shift_date::text as shift_date, s.starts_at, s.ends_at
           from public.shift_reports r
           join public.report_revisions v on v.report_id = r.id and v.revision_no = $2
           join public.shifts s on s.id = r.shift_id
          where r.id = $1`,
        [ev.report_id, ev.revision_no],
      );
      if (!row) throw new Error('Report revision not found');
      const content = ReportDraftContent.parse(row.content);
      const issues = await openIssues(q, row.department_id);
      const roster = await q.query<{ full_name: string; pseudonym: string }>(
        `select full_name, pseudonym from public.profiles where department_id = $1`,
        [row.department_id],
      );
      const records = await recentRecords(q, row.department_id, row.ends_at);

      const text = renderReportText(content, issues);
      const sanitized = sanitize(text, roster);
      const injection = detectInjection(sanitized.text);
      await q.query('select internal.store_analysis_input($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)', [
        ev.report_id,
        ev.revision_no,
        sanitized.text,
        JSON.stringify(sanitized.nameMapping),
        JSON.stringify(sanitized.counts),
        JSON.stringify(injection),
      ]);
      const prompt = buildHandoverPrompt(this.config.PROMPT_VERSION as PromptVersion, {
        reportId: row.reference_code,
        sanitizedReport: sanitized.text,
        shiftLabel: `${row.label} ${row.shift_date}`,
        openIssues: issues.map((i) => ({ code: i.code, title: sanitize(i.title, roster).text, status: i.status })),
        approvedRecords: records.map((r) => ({
          type: r.record_type,
          reference: r.reference_code,
          title: sanitize(r.title, roster).text,
          details: sanitize(r.details, roster).text,
          recorded_at: new Date(r.recorded_at).toISOString(),
        })),
      });
      return {
        eventId: ev.id,
        attempt: ev.attempts,
        idempotencyKey: `${ev.idempotency_key}:a${ev.attempts}`,
        reportId: ev.report_id,
        reportRef: row.reference_code,
        revision: ev.revision_no,
        prompt,
        sanitizedText: sanitized.text,
        openIssues: issues.map((i) => ({ code: i.code, title: sanitize(i.title, roster).text })),
      };
    });
  }

  /**
   * Validates raw model output and stores it. Called by the n8n callback route and by the
   * dev adapter. Invalid output is recorded as such and retried; it never reaches reviewers.
   */
  async complete(eventId: string, attempt: number, rawOutput: unknown, meta: CompletionMeta): Promise<'recorded' | 'ignored' | 'invalid'> {
    const ctx = await this.db.asService(async (q) => {
      const [row] = await q.query<{
        report_id: string;
        revision_no: number;
        reference_code: string;
        department_id: string;
        sanitized_text: string | null;
        injection_findings: InjectionFinding[] | null;
        ends_at: Date;
        status: string;
        attempts: number;
      }>(
        `select e.report_id, e.revision_no, r.reference_code, r.department_id, a.sanitized_text, a.injection_findings,
                s.ends_at, e.status, e.attempts
           from public.automation_events e
           join public.shift_reports r on r.id = e.report_id
           join public.shifts s on s.id = r.shift_id
           left join internal.analysis_inputs a on a.report_id = e.report_id and a.revision_no = e.revision_no
          where e.id = $1 and e.kind = 'report_analysis'`,
        [eventId],
      );
      if (!row) return null;
      const records = await recentRecords(q, row.department_id, row.ends_at);
      const issues = await openIssues(q, row.department_id);
      return { ...row, records, issueCodes: issues.map((i) => i.code) };
    });
    if (!ctx || ctx.status !== 'dispatched' || ctx.attempts !== attempt) return 'ignored';

    const runMeta = {
      prompt_version: this.config.PROMPT_VERSION,
      engine: meta.engine,
      model: meta.model ?? null,
      is_simulated: meta.isSimulated,
      latency_ms: meta.latencyMs ?? null,
    };

    let parsedJson: unknown = rawOutput;
    if (typeof rawOutput === 'string') {
      try {
        parsedJson = JSON.parse(rawOutput.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        await this.recordFailure(eventId, attempt, 'invalid_output', 'Model output was not valid JSON', {
          ...runMeta,
          validation_errors: [{ path: '', message: 'Not valid JSON' }],
        });
        return 'invalid';
      }
    }
    const result = AiHandoverDraft.safeParse(parsedJson);
    if (!result.success || result.data.report_id !== ctx.reference_code) {
      const errors = result.success
        ? [{ path: 'report_id', message: `Expected ${ctx.reference_code}` }]
        : result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
      await this.recordFailure(eventId, attempt, 'invalid_output', 'Model output failed schema validation', {
        ...runMeta,
        validation_errors: errors,
      });
      return 'invalid';
    }

    const grounded = groundDraft(result.data, {
      sourceText: ctx.sanitized_text ?? '',
      records: ctx.records,
      openIssueCodes: ctx.issueCodes,
      injection: ctx.injection_findings ?? [],
    });
    const outcome = await this.db.asService(async (q) => {
      const [r] = await q.query<{ result: string }>('select internal.record_analysis_result($1, $2, $3::jsonb) as result', [
        eventId,
        attempt,
        JSON.stringify({ ...runMeta, draft: grounded.draft, flags: grounded.flags, usage: meta.usage ?? null }),
      ]);
      return r!.result as 'recorded' | 'ignored';
    });
    this.log('analysis recorded', { event: eventId, outcome, flags: grounded.flags.length, simulated: meta.isSimulated });
    return outcome;
  }

  async recordFailure(eventId: string, attempt: number, status: 'failed' | 'invalid_output', error: string, run: Record<string, unknown> | null) {
    return this.db.asService(async (q) => {
      const [r] = await q.query<{ result: string }>(
        'select internal.record_analysis_failure($1, $2, $3, $4, $5::jsonb) as result',
        [eventId, attempt, status, error, run ? JSON.stringify(run) : null],
      );
      return r!.result;
    });
  }
}

async function openIssues(q: Queryable, departmentId: string) {
  return q.query<{ id: string; code: string; title: string; status: string }>(
    `select id, code, title, status from public.operational_issues
      where department_id = $1 and status in ('reported','pending_verification','open','in_progress','resolution_submitted')
      order by created_at desc limit 50`,
    [departmentId],
  );
}

async function recentRecords(q: Queryable, departmentId: string, around: Date) {
  return q.query<GroundingRecord & { details: string; recorded_at: Date }>(
    `select record_type, reference_code, title, details, recorded_at from public.operational_records
      where department_id = $1 and (record_type = 'policy' or recorded_at between $2::timestamptz - interval '72 hours' and $2::timestamptz + interval '6 hours')
      order by recorded_at desc limit 40`,
    [departmentId, around],
  );
}

/** Development adapter: deterministic simulator, clearly labeled. No external call is made. */
export function createDevAnalysisAdapter(delayMs: number, log: Logger = () => {}): AnalysisAdapter {
  return {
    name: 'dev',
    async dispatch(job, pipeline) {
      const run = async () => {
        const started = Date.now();
        const draft = simulateAnalysis(job.reportRef, job.sanitizedText, job.openIssues);
        await pipeline.complete(job.eventId, job.attempt, draft, {
          engine: 'dev-simulator',
          model: null,
          isSimulated: true,
          latencyMs: Date.now() - started,
        });
      };
      if (delayMs <= 0) return run();
      setTimeout(() => run().catch((e) => log('dev analysis failed', { error: String(e) })), delayMs);
    },
  };
}

/**
 * Admin-configured adapter (the default): calls the provider the administrator connected on the
 * admin page (Gemini or Grok) with the stored, encrypted key. Until a provider and key are saved,
 * it runs the clearly labeled simulator instead. A provider failure is thrown, so the event is
 * retried with backoff and, after the last attempt, goes to the supervisor for manual review.
 */
export function createAdminAnalysisAdapter(
  settings: AiSettings,
  opts: { fetchImpl?: typeof fetch; timeoutMs: number; devDelayMs: number; log?: Logger },
): AnalysisAdapter {
  const simulator = createDevAnalysisAdapter(opts.devDelayMs, opts.log);
  return {
    name: 'admin',
    async dispatch(job, pipeline) {
      const active = await settings.active();
      if (!active) return simulator.dispatch(job, pipeline);
      const reply = await callProvider(opts.fetchImpl ?? fetch, active.provider, active.model, active.apiKey, job.prompt, opts.timeoutMs);
      await pipeline.complete(job.eventId, job.attempt, reply.text, {
        engine: active.provider,
        model: active.model,
        isSimulated: false,
        latencyMs: reply.latencyMs,
        usage: reply.usage,
      });
    },
    async status() {
      const v = await settings.view();
      const live = v.provider !== 'simulator' && v.has_key && v.encryption_available;
      return { adapter: 'admin', provider: live ? v.provider : null, model: live ? (v.model ?? AI_PROVIDERS[v.provider as 'gemini' | 'grok'].defaultModel) : null, simulated: !live };
    },
  };
}

/** n8n adapter: hands the rendered prompt to Workflow A over authenticated HTTPS. */
export function createN8nAnalysisAdapter(config: Config, fetchImpl: typeof fetch = fetch): AnalysisAdapter {
  return {
    name: 'n8n',
    async dispatch(job) {
      const res = await fetchImpl(config.N8N_ANALYSIS_WEBHOOK_URL!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Silent-Handover-Secret': config.N8N_WEBHOOK_SECRET!,
          'Idempotency-Key': job.idempotencyKey,
        },
        body: JSON.stringify({
          event_id: job.eventId,
          attempt: job.attempt,
          idempotency_key: job.idempotencyKey,
          report_id: job.reportRef,
          prompt_version: job.prompt.version,
          system_prompt: job.prompt.system,
          user_prompt: job.prompt.user,
          response_schema: job.prompt.responseSchema,
          callback_url: `${config.PUBLIC_API_URL}/api/integrations/n8n/analysis-result`,
        }),
        signal: AbortSignal.timeout(config.N8N_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
    },
  };
}
