<script setup lang="ts">
import type { OrganizationRules, PromptElements } from '@sh/shared';

/**
 * The six elements of a prompt as the AI receives them. Locked elements come from the code;
 * the organization rules an administrator added are shown in elements 3 and 5, highlighted.
 */
defineProps<{ elements: PromptElements; organization?: OrganizationRules | null }>();
const ELEMENTS = [
  { key: 'rolePersona', n: 1, title: 'Role' },
  { key: 'taskObjective', n: 2, title: 'Task objective' },
  { key: 'contextAndPolicyRules', n: 3, title: 'Context and policy rules', org: 'policy_rules' },
  { key: 'injectionShield', n: 4, title: 'Delimiters and injection shield' },
  { key: 'negativeConstraints', n: 5, title: 'Negative constraints', org: 'negative_constraints' },
  { key: 'outputFormat', n: 6, title: 'Output format' },
] as const;
</script>

<template>
  <div class="grid gap-2 sm:grid-cols-2">
    <div v-for="el in ELEMENTS" :key="el.key" class="rounded-md border border-line p-3">
      <p class="flex items-center justify-between gap-2 text-[12px] font-semibold text-accent-ink">
        <span>{{ el.n }}. {{ el.title }}</span>
        <span class="text-[10.5px] font-normal tracking-wide text-ink-3 uppercase">{{ 'org' in el ? 'Locked + your rules' : 'Locked' }}</span>
      </p>
      <ul v-if="el.key === 'negativeConstraints'" class="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">
        <li v-for="(c, i) in elements.negativeConstraints" :key="i">{{ c }}</li>
      </ul>
      <p v-else class="mt-1 text-[12.5px] whitespace-pre-wrap text-ink-2">{{ elements[el.key] }}</p>
      <div v-if="'org' in el && organization?.[el.org].length" class="mt-2 rounded border border-accent/20 bg-accent-soft/60 px-2.5 py-2">
        <p class="text-[11px] font-medium text-accent-ink">Added by your organization · rules v{{ organization.version }}</p>
        <ul class="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink-2">
          <li v-for="(r, i) in organization[el.org]" :key="i">{{ r }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>
