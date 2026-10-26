<script setup lang="ts">
import { computed } from 'vue';
import { REPORT_SECTIONS, type ReportDraftContent } from '@sh/shared';

/** Read-only rendering of an employee's own words, with optional evidence highlighting. */
const props = defineProps<{
  content: ReportDraftContent;
  issueLabels?: Record<string, string>;
  highlight?: string | null;
}>();

const sections = computed(() =>
  REPORT_SECTIONS.map((s) => {
    let text = props.content[s.key] ?? '';
    if (s.key === 'unresolved_issues' && props.content.no_unresolved_issues) text = 'None — confirmed by the employee.';
    if (s.key === 'pending_tasks' && props.content.no_pending_tasks) text = 'None — confirmed by the employee.';
    return { ...s, text };
  }).filter((s) => s.text.trim()),
);

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(text: string) {
  const safe = escapeHtml(text);
  const h = props.highlight?.trim().replace(/…$/, '');
  if (!h || h.length < 4) return safe;
  const idx = text.toLowerCase().indexOf(h.toLowerCase());
  if (idx < 0) return safe;
  return `${escapeHtml(text.slice(0, idx))}<mark class="evidence">${escapeHtml(text.slice(idx, idx + h.length))}</mark>${escapeHtml(text.slice(idx + h.length))}`;
}
</script>

<template>
  <div class="space-y-4">
    <section v-for="s in sections" :key="s.key">
      <h4 class="eyebrow">{{ s.label }}</h4>
      <!-- eslint-disable-next-line vue/no-v-html — input is escaped in render() -->
      <p class="mt-1 text-[14px] leading-relaxed whitespace-pre-wrap text-ink" v-html="render(s.text)" />
    </section>
    <section v-if="content.evidence_refs?.trim()">
      <h4 class="eyebrow">Evidence references</h4>
      <p class="mt-1 text-[14px] whitespace-pre-wrap" v-html="render(content.evidence_refs)" />
    </section>
    <section v-if="content.issue_updates?.length">
      <h4 class="eyebrow">Updates on existing issues</h4>
      <ul class="mt-1 space-y-1.5 text-[14px]">
        <li v-for="u in content.issue_updates" :key="u.issue_id">
          <span class="font-medium">{{ issueLabels?.[u.issue_id] ?? 'Existing issue' }}</span>
          <span class="text-ink-3"> — {{ u.claimed_status.replace('_', ' ') }}: </span>
          <span v-html="render(u.note)" />
        </li>
      </ul>
    </section>
  </div>
</template>
