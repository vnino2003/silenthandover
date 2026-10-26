<script setup lang="ts">
import { computed } from 'vue';
import { classifyWindow, formatDuration } from '@sh/shared';
import { time } from '@/lib/format';
import type { ShiftView } from '@/lib/types';

/**
 * Shows whether the employee can submit, with a countdown. The server decides the real
 * state when the employee submits; this only keeps the display current between refreshes.
 */
const props = defineProps<{ shift: ShiftView; now: number }>();

const state = computed(() => {
  const server = props.shift.window_state;
  if (server && !['early_draft', 'open', 'override', 'closed', 'not_started'].includes(server)) return server;
  return classifyWindow(props.shift, props.now);
});

const tz = computed(() => props.shift.timezone);
const view = computed(() => {
  const s = props.shift;
  const until = (iso: string) => formatDuration(new Date(iso).getTime() - props.now);
  switch (state.value) {
    case 'open':
      return { tone: 'open', title: 'Reporting window open', text: `Closes at ${time(s.window_closes_at, tz.value)} · ${until(s.window_closes_at)} left` };
    case 'override':
      return { tone: 'open', title: 'Window extended by your supervisor', text: `Submit before ${time(s.override_expires_at!, tz.value)}` };
    case 'early_draft':
      return {
        tone: 'soon',
        title: `Submission opens at ${time(s.window_opens_at, tz.value)}`,
        text: `In ${until(s.window_opens_at)}. You can start a draft now — it saves automatically.`,
      };
    case 'not_started':
      return { tone: 'soon', title: `Shift starts at ${time(s.starts_at, tz.value)}`, text: `Reporting opens at ${time(s.window_opens_at, tz.value)}.` };
    case 'closed':
      return { tone: 'closed', title: 'Reporting window closed', text: `Closed at ${time(s.window_closes_at, tz.value)}. Ask your supervisor if you need to submit late.` };
    case 'cancelled':
      return { tone: 'closed', title: 'Shift cancelled', text: 'No report is needed for this shift.' };
    default:
      return { tone: 'closed', title: 'Not assigned', text: 'You are no longer assigned to this shift.' };
  }
});
defineExpose({ state });
</script>

<template>
  <div class="flex items-start gap-3">
    <span
      class="mt-1.5 size-2.5 shrink-0 rounded-full"
      :class="{ 'bg-ok shadow-[0_0_0_4px] shadow-ok/15': view.tone === 'open', 'bg-warn': view.tone === 'soon', 'bg-ink-3': view.tone === 'closed' }"
      aria-hidden="true"
    />
    <div>
      <p class="text-[15px] font-medium" :class="view.tone === 'open' ? 'text-ok' : 'text-ink'">{{ view.title }}</p>
      <p class="text-[14px] text-ink-2 tnum">{{ view.text }}</p>
    </div>
  </div>
</template>
