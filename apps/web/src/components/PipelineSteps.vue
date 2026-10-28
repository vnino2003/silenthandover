<script setup lang="ts">
import { computed, ref } from 'vue';
import type { OrganizationRules, ServerFlag } from '@sh/shared';
import FlagList from '@/components/FlagList.vue';
import PromptElementsView from '@/components/PromptElementsView.vue';

/**
 * One report's journey to the AI and back, step by step: template and fallbacks, privacy
 * redactions, the injection check, the six-element prompt, the answer, the format check and the
 * grounding flags. Used for real reports (censored: only what the AI received) and for examples.
 */
export interface PipelineField {
  name: string;
  fallback: string | null;
  usedFallback: boolean;
  value: string;
}
export interface PipelineView {
  template: { report: string; report_fields: PipelineField[]; prompt: string; prompt_fields: PipelineField[] };
  /** Examples only: the text before redaction. Real reports never include it. */
  report_text?: string;
  sanitized: { text: string; counts: Record<string, number>; names?: { token: string; name: string }[] };
  injection: { rule: string; excerpt: string }[];
  prompt: {
    version: string;
    elements: { rolePersona: string; taskObjective: string; contextAndPolicyRules: string; injectionShield: string; negativeConstraints: string[]; outputFormat: string };
    /** The organization rules this prompt used (null for runs from before rules existed). */
    organization: OrganizationRules | null;
    system: string;
    user: string;
    output_fields: string[];
  };
  ai: { engine: string; model: string | null; simulated: boolean; latency_ms: number; raw: string };
  validation: { ok: boolean; errors: { path: string; message: string }[]; status?: string };
  grounding: { flags: ServerFlag[]; draft: unknown } | null;
}

const props = defineProps<{ view: PipelineView; real?: boolean }>();

type Part = { text: string; kind: 'plain' | 'field' | 'token' | 'tag' };
function highlight(text: string, pattern: RegExp, kind: Part['kind']): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index), kind: 'plain' });
    parts.push({ text: m[0], kind });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), kind: 'plain' });
  return parts;
}
const FIELD_RE = /\{\{[^}]+\}\}/g;
const TOKEN_RE = /\[(?:EMP-[A-Z0-9]{6}|PERSON-\d+|[A-Z]+-REDACTED)\]/g;
const TAG_RE = /<\/?(?:department_guidance|open_issues|approved_records|raw_input)>/g;
const PART_CLASS: Record<Part['kind'], string> = {
  plain: '',
  field: 'rounded bg-info-soft px-0.5 text-info',
  token: 'rounded bg-violet-soft px-0.5 font-medium text-violet',
  tag: 'font-semibold text-accent-ink',
};
const REDACTION_LABELS: Record<string, string> = {
  employee_name: 'Employee names',
  other_person: 'Other people',
  email: 'Emails',
  phone: 'Phone numbers',
  government_id: 'Government IDs',
  medical: 'Health details',
};

const redactions = computed(() => Object.entries(props.view.sanitized.counts).filter(([, n]) => n > 0));
const removed = computed(() => redactions.value.reduce((n, [, c]) => n + c, 0));
const fallbacks = computed(() => props.view.template.report_fields.filter((f) => f.usedFallback).length);
// Steps 1–3 start open; the long ones (prompt, raw answer) start closed.
const open = ref<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: false, 5: false });
const toggle = (n: number) => (open.value[n] = !open.value[n]);
const ms = (v: number) => (v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
</script>

<template>
  <ol class="stagger space-y-3" aria-label="Pipeline steps">
    <!-- 1. Template -->
    <li class="card">
      <button type="button" class="flex w-full items-start gap-3 px-5 py-4 text-left" :aria-expanded="open[1]" @click="toggle(1)">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-info-soft text-[13px] font-semibold text-info">1</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-semibold">Template and fallbacks</span>
          <span class="block text-[13px] text-ink-3">The answers go into a fixed template. A blank box gets its fallback, so the AI is told “none stated” instead of guessing.</span>
        </span>
        <span class="text-[12.5px] font-medium tnum" :class="fallbacks ? 'text-warn' : 'text-ok'">{{ fallbacks ? `${fallbacks} fallback${fallbacks === 1 ? '' : 's'} used` : 'All filled in' }}</span>
      </button>
      <div class="expand" :class="{ open: open[1] }">
        <div>
          <div class="grid gap-4 border-t border-line px-5 py-4 lg:grid-cols-2">
            <div>
              <p class="eyebrow mb-1.5">Template</p>
              <pre class="overflow-x-auto rounded-md bg-canvas p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap"><span v-for="(p, i) in highlight(view.template.report, FIELD_RE, 'field')" :key="i" :class="PART_CLASS[p.kind]">{{ p.text }}</span></pre>
            </div>
            <div>
              <p class="eyebrow mb-1.5">Filled in{{ real ? ' (censored)' : '' }}</p>
              <ul class="divide-y divide-line rounded-md border border-line text-[13px]">
                <li v-for="f in view.template.report_fields" :key="f.name" class="px-3 py-2">
                  <p class="flex items-center justify-between gap-2">
                    <code class="text-info" v-text="`{{${f.name}}}`" />
                    <span v-if="f.usedFallback" class="rounded-full bg-warn-soft px-2 py-px text-[11.5px] font-medium text-warn">fallback used</span>
                    <span v-else class="rounded-full bg-ok-soft px-2 py-px text-[11.5px] font-medium text-ok">from the employee</span>
                  </p>
                  <p class="mt-0.5 line-clamp-2 text-ink-2" :class="{ 'text-ink-3 italic': f.usedFallback }">
                    <span v-for="(p, i) in highlight(f.value, TOKEN_RE, 'token')" :key="i" :class="PART_CLASS[p.kind]">{{ p.text }}</span>
                  </p>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </li>

    <!-- 2. Privacy -->
    <li class="card">
      <button type="button" class="flex w-full items-start gap-3 px-5 py-4 text-left" :aria-expanded="open[2]" @click="toggle(2)">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-violet-soft text-[13px] font-semibold text-violet">2</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-semibold">Privacy: personal details removed (RA 10173)</span>
          <span class="block text-[13px] text-ink-3">Names become codes; phone numbers, IDs and health details are removed. Only this censored version is sent to the AI.</span>
        </span>
        <span class="text-[12.5px] font-medium tnum text-violet">{{ removed }} removed</span>
      </button>
      <div class="expand" :class="{ open: open[2] }">
        <div>
          <div class="space-y-4 border-t border-line px-5 py-4">
            <div v-if="redactions.length" class="flex flex-wrap gap-2">
              <span v-for="[k, n] in redactions" :key="k" class="rounded-full border border-violet/30 bg-violet-soft px-2.5 py-0.5 text-[12.5px] text-violet tnum">{{ REDACTION_LABELS[k] ?? k }}: {{ n }}</span>
            </div>
            <p v-else class="text-[13px] text-ink-3">Nothing personal found.</p>
            <div class="grid gap-4" :class="{ 'lg:grid-cols-2': view.report_text }">
              <div v-if="view.report_text">
                <p class="eyebrow mb-1.5">Before</p>
                <pre class="max-h-72 overflow-auto rounded-md bg-canvas p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap">{{ view.report_text }}</pre>
              </div>
              <div>
                <p class="eyebrow mb-1.5">{{ real ? 'What the AI received (censored)' : 'After — what the AI receives' }}</p>
                <pre class="max-h-72 overflow-auto rounded-md bg-canvas p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap"><span v-for="(p, i) in highlight(view.sanitized.text, TOKEN_RE, 'token')" :key="i" :class="PART_CLASS[p.kind]">{{ p.text }}</span></pre>
              </div>
            </div>
            <p v-if="real" class="text-[12.5px] text-ink-3">
              The original report and the list matching codes to names stay inside the system. Only the supervisor sees names, after the codes are put back.
            </p>
            <div v-else-if="view.sanitized.names?.length">
              <p class="eyebrow mb-1.5">Codes kept inside the system (put back for the supervisor only)</p>
              <ul class="flex flex-wrap gap-2 text-[12.5px]">
                <li v-for="n in view.sanitized.names" :key="n.token" class="rounded-md border border-line px-2 py-1"><code class="text-violet">{{ n.token }}</code> → {{ n.name }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </li>

    <!-- 3. Injection -->
    <li class="card">
      <button type="button" class="flex w-full items-start gap-3 px-5 py-4 text-left" :aria-expanded="open[3]" @click="toggle(3)">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-warn-soft text-[13px] font-semibold text-warn">3</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-semibold">Injection check</span>
          <span class="block text-[13px] text-ink-3">Text that tries to give the AI orders is found here, flagged for the supervisor, and treated as plain data.</span>
        </span>
        <span class="text-[12.5px] font-medium tnum" :class="view.injection.length ? 'text-bad' : 'text-ok'">{{ view.injection.length ? `${view.injection.length} found` : 'None found' }}</span>
      </button>
      <div class="expand" :class="{ open: open[3] }">
        <div>
          <ul v-if="view.injection.length" class="space-y-2 border-t border-line px-5 py-4 text-[13px]">
            <li v-for="(f, i) in view.injection" :key="i" class="rounded-md border border-bad/25 bg-bad-soft/50 px-3 py-2">
              <span class="font-medium text-bad">{{ f.rule.replace(/_/g, ' ') }}</span> · “{{ f.excerpt }}”
            </li>
          </ul>
          <p v-else class="border-t border-line px-5 py-4 text-[13px] text-ink-3">No instructions aimed at the AI.</p>
        </div>
      </div>
    </li>

    <!-- 4. Prompt -->
    <li class="card">
      <button type="button" class="flex w-full items-start gap-3 px-5 py-4 text-left" :aria-expanded="open[4]" @click="toggle(4)">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent-ink">4</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-semibold">The six-element prompt (v{{ view.prompt.version }}<template v-if="view.prompt.organization"> · organization rules v{{ view.prompt.organization.version }}</template>)</span>
          <span class="block text-[13px] text-ink-3">The instructions the AI gets every time, plus the censored report placed between delimiters.</span>
        </span>
        <span class="text-[12.5px] text-ink-3">{{ open[4] ? 'Hide' : 'Show' }}</span>
      </button>
      <div class="expand" :class="{ open: open[4] }">
        <div>
          <div class="space-y-4 border-t border-line px-5 py-4">
            <PromptElementsView :elements="view.prompt.elements" :organization="view.prompt.organization" />
            <p v-if="real && !view.prompt.organization" class="text-[12px] text-ink-3">This report was cleaned before organization rules existed.</p>
            <div class="grid gap-4 lg:grid-cols-2">
              <div>
                <p class="eyebrow mb-1.5">Message template</p>
                <pre class="overflow-x-auto rounded-md bg-canvas p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap"><span v-for="(p, i) in highlight(view.template.prompt, FIELD_RE, 'field')" :key="i" :class="PART_CLASS[p.kind]">{{ p.text }}</span></pre>
                <p class="mt-1.5 text-[12px] text-ink-3">
                  Fallbacks here:
                  <template v-for="(f, i) in view.template.prompt_fields.filter((x) => x.usedFallback)" :key="f.name">{{ i ? ', ' : '' }}<code class="text-info" v-text="`{{${f.name}}}`" /> → {{ f.value }}</template>
                  <template v-if="!view.template.prompt_fields.some((x) => x.usedFallback)">none</template>
                </p>
              </div>
              <div>
                <p class="eyebrow mb-1.5">Message sent</p>
                <pre class="max-h-80 overflow-auto rounded-md bg-canvas p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap"><span v-for="(p, i) in highlight(view.prompt.user, TAG_RE, 'tag')" :key="i" :class="PART_CLASS[p.kind]">{{ p.text }}</span></pre>
              </div>
            </div>
            <p class="text-[12.5px] text-ink-3">
              The AI must answer with these fields only, as JSON:
              <code v-for="f in view.prompt.output_fields" :key="f" class="mr-1.5 inline-block rounded bg-sunken px-1 text-[12px]">{{ f }}</code>
            </p>
          </div>
        </div>
      </div>
    </li>

    <!-- 5. Answer -->
    <li class="card">
      <button type="button" class="flex w-full items-start gap-3 px-5 py-4 text-left" :aria-expanded="open[5]" @click="toggle(5)">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-semibold text-white">5</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-semibold">{{ view.ai.simulated ? 'Mica practice answer' : 'Mica’s AI answer' }}</span>
          <span class="block text-[13px] text-ink-3">
            {{ view.ai.simulated ? 'Made by Mica’s built-in rule-based simulator (no AI called), in the same format the AI must use.' : `Mica answered through ${view.ai.engine}${view.ai.model ? ` · ${view.ai.model}` : ''}.` }}
            {{ real ? 'Names are still codes here.' : '' }}
          </span>
        </span>
        <span class="text-[12.5px] text-ink-3 tnum">{{ ms(view.ai.latency_ms) }}</span>
      </button>
      <div class="expand" :class="{ open: open[5] }">
        <div>
          <pre v-if="view.ai.raw" class="max-h-96 overflow-auto border-t border-line bg-canvas px-5 py-4 text-[12px] leading-relaxed">{{ view.ai.raw }}</pre>
          <p v-else class="border-t border-line px-5 py-4 text-[13px] text-ink-3">No accepted answer for this attempt.</p>
        </div>
      </div>
    </li>

    <!-- 6. Validation -->
    <li class="card px-5 py-4">
      <div class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold" :class="view.validation.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'">6</span>
        <div class="min-w-0 flex-1">
          <p class="text-[15px] font-semibold">Format check</p>
          <p class="text-[13px] text-ink-3">The answer must be valid JSON with exactly the required fields, for this report. Anything else is rejected and retried.</p>
          <p v-if="view.validation.ok" class="mt-2 text-[13.5px] font-medium text-ok">✓ Valid — accepted</p>
          <template v-else>
            <p class="mt-2 text-[13.5px] font-medium text-bad">✕ Rejected{{ view.validation.status === 'failed' ? ' — the AI could not be reached' : '' }}</p>
            <ul class="mt-1 space-y-1 text-[13px] text-bad">
              <li v-for="(e, i) in view.validation.errors" :key="i"><code>{{ e.path || '(whole answer)' }}</code>: {{ e.message }}</li>
            </ul>
          </template>
        </div>
      </div>
    </li>

    <!-- 7. Grounding and flags -->
    <li class="card">
      <div class="flex items-start gap-3 px-5 py-4">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-bad-soft text-[13px] font-semibold text-bad">7</span>
        <div class="min-w-0 flex-1">
          <p class="text-[15px] font-semibold">Grounding check and verification flags</p>
          <p class="text-[13px] text-ink-3">Every item must trace back to the employee’s words; repairs need a record. What can’t be trusted becomes a flag the supervisor must decide on.</p>
        </div>
        <span v-if="view.grounding" class="text-[12.5px] font-medium tnum" :class="view.grounding.flags.length ? 'text-warn' : 'text-ok'">
          {{ view.grounding.flags.length }} flag{{ view.grounding.flags.length === 1 ? '' : 's' }}
        </span>
      </div>
      <div v-if="view.grounding?.flags.length" class="border-t border-line px-5 py-4">
        <FlagList :flags="view.grounding.flags" :resolutions="{}" readonly />
      </div>
      <p v-else-if="view.grounding" class="border-t border-line px-5 py-4 text-[13px] text-ink-3">No flags — nothing doubtful.</p>
      <p v-else class="border-t border-line px-5 py-4 text-[13px] text-ink-3">Skipped because the answer was not accepted.</p>
    </li>

    <li class="rounded-lg border border-dashed border-line-strong px-5 py-4 text-[13.5px] text-ink-2">
      <span class="font-semibold text-ink">Then a person decides.</span>
      The supervisor sees the employee’s original next to this draft (with names put back), edits it, decides every flag and approves.
      Only the approved version reaches the next shift. The AI never approves, never marks a problem solved and never sends anything.
    </li>
  </ol>
</template>
