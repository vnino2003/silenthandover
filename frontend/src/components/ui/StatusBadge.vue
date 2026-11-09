<script setup lang="ts">
import { computed } from 'vue';
import { IonBadge } from '@ionic/vue';
import { ISSUE_STATUS_LABELS, REPORT_STATUS_LABELS, type IssueStatus, type ReportStatus } from '@sh/shared';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'violet' | 'accent';

/** A status label, built on Ionic's IonBadge, coloured by meaning. */
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
  neutral: '[--background:var(--color-sunken)] [--color:var(--color-ink-2)] [--dot:var(--color-ink-3)]',
  ok: '[--background:var(--color-ok-soft)] [--color:var(--color-ok)] [--dot:var(--color-ok)]',
  warn: '[--background:var(--color-warn-soft)] [--color:var(--color-warn)] [--dot:var(--color-warn)]',
  bad: '[--background:var(--color-bad-soft)] [--color:var(--color-bad)] [--dot:var(--color-bad)]',
  info: '[--background:var(--color-info-soft)] [--color:var(--color-info)] [--dot:var(--color-info)]',
  violet: '[--background:var(--color-violet-soft)] [--color:var(--color-violet)] [--dot:var(--color-violet)]',
  accent: '[--background:var(--color-accent-soft)] [--color:var(--color-accent-ink)] [--dot:var(--color-accent)]',
};
</script>

<template>
  <IonBadge class="sh-badge inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap" :class="styles[view.tone]">
    <span class="size-1.5 rounded-full bg-(--dot)" aria-hidden="true" />
    <slot>{{ view.text }}</slot>
  </IonBadge>
</template>
