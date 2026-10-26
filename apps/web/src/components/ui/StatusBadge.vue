<script setup lang="ts">
import { computed } from 'vue';
import { ISSUE_STATUS_LABELS, REPORT_STATUS_LABELS, type IssueStatus, type ReportStatus } from '@sh/shared';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'violet' | 'accent';

const props = defineProps<{
  report?: ReportStatus | null;
  issue?: IssueStatus;
  tone?: Tone;
  label?: string;
}>();

const REPORT_TONE: Record<ReportStatus, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  processing: 'info',
  pending_review: 'warn',
  revision_requested: 'violet',
  approved: 'ok',
  rejected: 'bad',
  delivered: 'ok',
};
const ISSUE_TONE: Record<IssueStatus, Tone> = {
  reported: 'warn',
  pending_verification: 'warn',
  open: 'bad',
  in_progress: 'info',
  resolution_submitted: 'violet',
  resolved: 'ok',
  closed: 'neutral',
};

const view = computed(() => {
  if (props.report) return { tone: REPORT_TONE[props.report], text: REPORT_STATUS_LABELS[props.report] };
  if (props.issue) return { tone: ISSUE_TONE[props.issue], text: ISSUE_STATUS_LABELS[props.issue] };
  return { tone: props.tone ?? 'neutral', text: props.label ?? '' };
});

const styles: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2 [--dot:var(--color-ink-3)]',
  ok: 'bg-ok-soft text-ok [--dot:var(--color-ok)]',
  warn: 'bg-warn-soft text-warn [--dot:var(--color-warn)]',
  bad: 'bg-bad-soft text-bad [--dot:var(--color-bad)]',
  info: 'bg-info-soft text-info [--dot:var(--color-info)]',
  violet: 'bg-violet-soft text-violet [--dot:var(--color-violet)]',
  accent: 'bg-accent-soft text-accent-ink [--dot:var(--color-accent)]',
};
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] leading-5 font-medium whitespace-nowrap"
    :class="styles[view.tone]"
  >
    <span class="size-1.5 rounded-full bg-(--dot)" aria-hidden="true" />
    <slot>{{ view.text }}</slot>
  </span>
</template>
