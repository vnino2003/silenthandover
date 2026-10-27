<script setup lang="ts">
import { computed, ref } from 'vue';
import { MICA_PROMPT_VERSION, MICA_PROMPTS, renderMicaSystem, renderMicaUser, type MicaPromptKind, type OrganizationRules } from '@sh/shared';
import PromptElementsView from '@/components/PromptElementsView.vue';

/**
 * Mica's assistant prompts, exactly as the server renders them (the same shared functions), with
 * the organization rules in use. Nothing here comes from a real conversation: Mica keeps none.
 */
const props = defineProps<{ organization: OrganizationRules | null }>();
const KINDS: { kind: MicaPromptKind; label: string; who: string; sent: string; kept: string }[] = [
  {
    kind: 'employee',
    label: 'Employee · Ask',
    who: 'A team member asks about a page, their schedule, leave or reports.',
    sent: 'The page guide and the sanitized question.',
    kept: 'Their shifts, leave and reports are shown by the app ("From your records"). Leave messages are handled by the app without the AI.',
  },
  {
    kind: 'manager',
    label: 'Supervisor · Ask',
    who: 'A supervisor asks about reviewing, coverage, schedules or leave decisions.',
    sent: 'The page guide and the sanitized question.',
    kept: "The department's coverage, conflicts, leave impact and review flags are shown by the app. Leave reasons are never included.",
  },
  {
    kind: 'admin',
    label: 'Administrator · Ask',
    who: 'An administrator asks about configuration or the AI pipeline.',
    sent: 'The page guide and the sanitized question.',
    kept: 'Organization-wide counts are shown by the app. Administrators never see report contents or leave reasons.',
  },
  {
    kind: 'prepare',
    label: 'Employee · Prepare',
    who: 'A team member turns a rough note into a shift report, incident, assistance request or task update.',
    sent: 'The sanitized message, the sanitized draft, issue codes and the department’s report categories.',
    kept: 'Names come back restored for the author only. The author reviews, edits and confirms before anything is recorded.',
  },
];
const selected = ref<MicaPromptKind>('employee');
const info = computed(() => KINDS.find((k) => k.kind === selected.value)!);
const system = computed(() => renderMicaSystem(selected.value, props.organization));
const example = computed(() =>
  renderMicaUser(
    selected.value === 'prepare'
      ? { role: 'employee', page: 'assistant', facts: '{ authorized_issue_codes, department_experience }', previousState: '{ the sanitized draft }', rawInput: '[EMP-887300] and I restocked 12 cribs.' }
      : { role: selected.value, page: 'leave_requests', guide: '(the guide text for the current page)', rawInput: 'How should I check coverage before approving?' },
  ),
);
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Which Mica prompt">
      <button
        v-for="k in KINDS"
        :key="k.kind"
        type="button"
        role="radio"
        :aria-checked="selected === k.kind"
        class="rounded-full border px-3 py-1.5 text-[13px]"
        :class="selected === k.kind ? 'border-accent bg-accent-soft font-medium text-accent-ink' : 'border-line text-ink-2 hover:border-accent/40'"
        @click="selected = k.kind"
      >
        {{ k.label }}
      </button>
    </div>
    <div class="grid gap-3 md:grid-cols-3">
      <div class="rounded-lg border border-line bg-surface p-4 text-[13px]"><p class="eyebrow mb-1">When</p><p class="text-ink-2">{{ info.who }}</p></div>
      <div class="rounded-lg border border-line bg-surface p-4 text-[13px]"><p class="eyebrow mb-1">Sent to the AI</p><p class="text-ink-2">{{ info.sent }}</p></div>
      <div class="rounded-lg border border-line bg-surface p-4 text-[13px]"><p class="eyebrow mb-1">Stays in the app</p><p class="text-ink-2">{{ info.kept }}</p></div>
    </div>
    <div>
      <p class="mb-2 text-[13px] font-medium">The six-element prompt ({{ MICA_PROMPT_VERSION }}<template v-if="organization"> · organization rules v{{ organization.version }}</template>)</p>
      <PromptElementsView :elements="MICA_PROMPTS[selected]" :organization="organization" />
    </div>
    <div class="grid gap-4 lg:grid-cols-2">
      <details class="card p-4">
        <summary class="cursor-pointer text-[13px] font-medium">Exact system prompt</summary>
        <pre class="mt-3 max-h-96 overflow-auto rounded-md bg-canvas p-3 text-[12px] leading-relaxed whitespace-pre-wrap">{{ system }}</pre>
      </details>
      <details class="card p-4">
        <summary class="cursor-pointer text-[13px] font-medium">Message layout (example)</summary>
        <pre class="mt-3 max-h-96 overflow-auto rounded-md bg-canvas p-3 text-[12px] leading-relaxed whitespace-pre-wrap">{{ example }}</pre>
        <p class="mt-2 text-[12px] text-ink-3">Each block sits in its own tag; anything in the question that looks like a tag is neutralized. A message that tries to steer the AI is not sent at all.</p>
      </details>
    </div>
    <p class="text-[12px] text-ink-3">
      After the AI answers, Mica checks the answer: the exact format, no numbers the user didn't give, no phone numbers, emails or links, and no claim that Mica did something. A failed check shows the page guide instead. Mica conversations are not stored.
    </p>
  </div>
</template>
