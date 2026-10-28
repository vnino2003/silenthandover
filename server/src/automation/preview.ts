import {
  AiHandoverDraft,
  escapeForDelimiters,
  fillHandoverPrompt,
  fillTemplate,
  handoverDraftJsonSchema,
  PROMPTS,
  renderSystemPrompt,
  templateFields,
  USER_PROMPT_TEMPLATE,
  type DepartmentGuidance,
  type OrganizationRules,
  type PromptVersion,
  type ReportDraftContent,
} from '@sh/shared';
import { callWithFallback, type AiSettings } from './ai-provider';
import { simulateAnalysis } from './dev-analyzer';
import { groundDraft } from './grounding';
import { detectInjection } from './injection';
import { fillReportTemplate, REPORT_TEMPLATE } from './report-text';
import { sanitize, type RosterEntry } from './sanitize';

/**
 * A real analysis run as the administrator may see it: only what was sent to the AI (already
 * censored) and what came back (names still as codes). The original report and the
 * code-to-name list are never included.
 */
export interface StoredRun {
  reference_code: string;
  shift_label: string;
  prompt_version: PromptVersion;
  sanitized_text: string | null;
  redaction_counts: Record<string, number> | null;
  injection_findings: { rule: string; excerpt: string }[] | null;
  engine: string | null;
  model: string | null;
  is_simulated: boolean;
  latency_ms: number | null;
  status: string;
  draft: unknown;
  flags: unknown[] | null;
  validation_errors: { path: string; message: string }[] | null;
  /** The organization rules this run used; null for runs from before rules existed. */
  org_rules: OrganizationRules | null;
}

export function describeStoredRun(run: StoredRun) {
  const text = run.sanitized_text ?? '';
  // Which boxes were blank: their section in the text sent to the AI holds the fallback.
  const fields = templateFields(REPORT_TEMPLATE).map((f) => {
    const header = REPORT_TEMPLATE.split('\n\n').find((s) => s.includes(`{{${f.name}`))!.split(':\n')[0]!;
    const start = text.indexOf(`${header}:\n`);
    const rest = start < 0 ? '' : text.slice(start + header.length + 2);
    const body = rest.split(/\n\n(?=[A-Z ]+:\n)/)[0]?.trim() ?? '';
    return { name: f.name, fallback: f.fallback, usedFallback: body === f.fallback, value: body };
  });
  const user = fillTemplate(USER_PROMPT_TEMPLATE, {
    report_id: run.reference_code,
    shift: escapeForDelimiters(run.shift_label),
    // These lists are rebuilt from the department's data for every run and are not kept.
    department_guidance: '(the department’s terms and privacy guidance at that time — not kept)',
    open_issues: '(the department’s open tickets at that time — not kept)',
    approved_records: '(the department’s source records at that time — not kept)',
    raw_input: escapeForDelimiters(text),
  });
  return {
    template: { report: REPORT_TEMPLATE, report_fields: fields, prompt: USER_PROMPT_TEMPLATE, prompt_fields: user.fields },
    sanitized: { text, counts: run.redaction_counts ?? {} },
    injection: run.injection_findings ?? [],
    prompt: {
      version: run.prompt_version,
      elements: PROMPTS[run.prompt_version],
      organization: run.org_rules,
      system: renderSystemPrompt(run.prompt_version, run.org_rules),
      user: user.text,
      output_fields: Object.keys((handoverDraftJsonSchema().properties as Record<string, unknown> | undefined) ?? {}),
    },
    ai: {
      engine: run.engine ?? 'unknown',
      model: run.model,
      simulated: run.is_simulated,
      latency_ms: run.latency_ms ?? 0,
      // The accepted answer as stored: names stay as codes here.
      raw: run.draft ? JSON.stringify(run.draft, null, 2) : '',
    },
    validation: { ok: run.status === 'succeeded', errors: run.validation_errors ?? [], status: run.status },
    grounding: run.status === 'succeeded' ? { flags: run.flags ?? [], draft: run.draft } : null,
  };
}

/**
 * Runs an example report through every step of the real pipeline and returns what each step
 * produced, for the administrator's "AI pipeline" page. Nothing is stored and nothing reaches a
 * supervisor or the next shift. It uses the same functions as a real submission, so what it
 * shows is what really happens.
 */
export async function previewPipeline(opts: {
  content: ReportDraftContent;
  roster: RosterEntry[];
  promptVersion: PromptVersion;
  orgRules: OrganizationRules;
  department?: DepartmentGuidance | null;
  engine: 'simulator' | 'provider';
  aiSettings: AiSettings;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}) {
  const reportId = 'SR-PREVIEW';

  // 1. The employee's answers are laid out with the report template; blanks use their fallback.
  const report = fillReportTemplate(opts.content, []);

  // 2. Personal details are replaced before anything leaves the system.
  const sanitized = sanitize(report.text, opts.roster);

  // 3. Text that tries to instruct the AI is detected (and later treated as data).
  const injection = detectInjection(sanitized.text);

  // 4. The six-element prompt, with the sanitized report placed between delimiters.
  const filled = fillHandoverPrompt(opts.promptVersion, {
    reportId,
    sanitizedReport: sanitized.text,
    shiftLabel: 'Example shift',
    openIssues: [],
    approvedRecords: [],
    department: opts.department ?? null,
  }, opts.orgRules);

  // 5. The model (or the labeled simulator) answers.
  let ai: { engine: string; model: string | null; simulated: boolean; latency_ms: number; raw: string };
  const active = opts.engine === 'provider' ? await opts.aiSettings.active() : null;
  if (opts.engine === 'provider' && !active) throw new Error('no_provider');
  if (active) {
    const reply = await callWithFallback(
      opts.aiSettings,
      opts.fetchImpl,
      { provider: active.provider, apiKey: active.apiKey, model: active.automatic ? null : active.model },
      filled.prompt,
      Math.min(opts.timeoutMs, 25000),
      70000,
    );
    ai = { engine: active.provider, model: reply.model, simulated: false, latency_ms: reply.latencyMs, raw: reply.text };
  } else {
    const started = Date.now();
    const draft = simulateAnalysis(reportId, sanitized.text, []);
    ai = { engine: 'dev-simulator', model: null, simulated: true, latency_ms: Date.now() - started, raw: JSON.stringify(draft, null, 2) };
  }

  // 6. The answer must be valid JSON in the required shape, for this report.
  const errors: { path: string; message: string }[] = [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(ai.raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    errors.push({ path: '', message: 'Not valid JSON' });
  }
  const result = parsed === null ? null : AiHandoverDraft.safeParse(parsed);
  if (result && !result.success) errors.push(...result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })));
  if (result?.success && result.data.report_id !== reportId) errors.push({ path: 'report_id', message: `Expected ${reportId}` });

  // 7. Grounding: every item must trace back to the report; risky claims become flags.
  const grounded = result?.success && !errors.length ? groundDraft(result.data, { sourceText: sanitized.text, records: [], openIssueCodes: [], injection }) : null;

  return {
    template: {
      report: REPORT_TEMPLATE,
      report_fields: report.fields,
      prompt: USER_PROMPT_TEMPLATE,
      prompt_fields: filled.fields,
    },
    report_text: report.text,
    sanitized: {
      text: sanitized.text,
      counts: sanitized.counts,
      // Shown only to the administrator for this example; real mappings never leave the API.
      names: Object.entries(sanitized.nameMapping).map(([token, name]) => ({ token, name })),
    },
    injection,
    prompt: {
      version: opts.promptVersion,
      elements: PROMPTS[opts.promptVersion],
      organization: opts.orgRules,
      system: filled.prompt.system,
      user: filled.prompt.user,
      output_fields: Object.keys((filled.prompt.responseSchema.properties as Record<string, unknown> | undefined) ?? {}),
    },
    ai,
    validation: { ok: errors.length === 0, errors },
    grounding: grounded ? { flags: grounded.flags, draft: grounded.draft } : null,
  };
}
