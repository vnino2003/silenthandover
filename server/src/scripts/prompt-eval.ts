/**
 * Prompt regression run for the TESDA v1.0 → v1.1 diagnostic plan.
 *
 *   OPENAI_API_KEY=... OPENAI_MODEL=... npm run prompt:eval -- --version 1.0
 *   npm run prompt:eval -- --simulator      (exercises the harness only — NOT a prompt result)
 *
 * Results are written to docs/capstone/prompt-eval-results/. Nothing is written unless a run
 * actually happened, so the documentation can only cite real results.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiHandoverDraft, buildHandoverPrompt, PROMPT_VERSIONS, type PromptVersion } from '@sh/shared';
import { simulateAnalysis } from '../automation/dev-analyzer';
import { groundDraft } from '../automation/grounding';
import { detectInjection } from '../automation/injection';
import { FIXTURES } from './prompt-fixtures';

const args = process.argv.slice(2);
const vi = args.indexOf('--version');
const version = (vi >= 0 ? args[vi + 1] : '1.0') as PromptVersion;
const simulator = args.includes('--simulator');
if (!PROMPT_VERSIONS.includes(version)) throw new Error(`Unknown prompt version ${version}`);
const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
if (!simulator && (!key || !model)) {
  console.error('Set OPENAI_API_KEY and OPENAI_MODEL to run against a live model, or pass --simulator to test the harness.');
  process.exit(2);
}

async function callModel(system: string, user: string, schema: Record<string, unknown>): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'handover_draft', strict: true, schema } },
    }),
  });
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.choices?.[0]?.message?.content ?? '';
}

const results = [];
for (const f of FIXTURES) {
  const reportId = `EVAL-${f.id}`;
  const prompt = buildHandoverPrompt(version, { reportId, sanitizedReport: f.text, shiftLabel: 'Evaluation', openIssues: [], approvedRecords: [] });
  let raw = '';
  let error: string | null = null;
  try {
    raw = simulator ? JSON.stringify(simulateAnalysis(reportId, f.text)) : await callModel(prompt.system, prompt.user, prompt.responseSchema);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* recorded as invalid below */
  }
  const valid = AiHandoverDraft.safeParse(parsed);
  const checks = valid.success ? f.checks.map((c) => ({ name: c.name, pass: c.pass(valid.data) })) : [];
  const grounding = valid.success
    ? groundDraft(valid.data, { sourceText: f.text, records: [], openIssueCodes: [], injection: detectInjection(f.text) }).flags.map((x) => x.type)
    : [];
  results.push({
    id: f.id,
    category: f.category,
    error,
    schema_valid: valid.success,
    checks,
    passed: valid.success && checks.every((c) => c.pass),
    grounding_flags: grounding,
  });
  console.log(`${valid.success && checks.every((c) => c.pass) ? 'PASS' : 'FAIL'}  ${f.id}${error ? `  (${error})` : ''}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../docs/capstone/prompt-eval-results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = resolve(outDir, `${stamp}-v${version}-${simulator ? 'SIMULATOR' : model}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      prompt_version: version,
      engine: simulator ? 'dev-simulator (harness check only — not a prompt evaluation)' : `openai:${model}`,
      ran_at: new Date().toISOString(),
      summary: { total: results.length, passed: results.filter((r) => r.passed).length },
      results,
    },
    null,
    2,
  ),
);
console.log(`\n${results.filter((r) => r.passed).length}/${results.length} passed — written to ${file}`);
