<script setup lang="ts">
import { computed } from 'vue';
import { formatDuration } from '@sh/shared';
import { time } from '@/lib/format';

/**
 * How far through their shift a worker is: a ring that fills as the shift goes on, with the
 * reporting window marked as a lighter band at the end, and the key times underneath.
 */
const props = defineProps<{
  shift: { starts_at: string; ends_at: string; window_opens_at: string; timezone: string };
  now: number;
}>();

const R = 46;
const C = 2 * Math.PI * R;

const span = computed(() => {
  const start = new Date(props.shift.starts_at).getTime();
  const end = new Date(props.shift.ends_at).getTime();
  const opens = new Date(props.shift.window_opens_at).getTime();
  return { start, end, opens, total: Math.max(1, end - start) };
});
const fraction = computed(() => Math.max(0, Math.min(1, (props.now - span.value.start) / span.value.total)));
const windowFrom = computed(() => Math.max(0, Math.min(1, (span.value.opens - span.value.start) / span.value.total)));
const phase = computed(() =>
  props.now < span.value.start ? 'upcoming' : props.now >= span.value.end ? 'done' : props.now >= span.value.opens ? 'reporting' : 'on',
);
const center = computed(() => {
  if (phase.value === 'upcoming') return { big: formatDuration(span.value.start - props.now), small: 'until start' };
  if (phase.value === 'done') return { big: 'Done', small: 'shift ended' };
  return { big: formatDuration(span.value.end - props.now), small: 'left' };
});
const caption = computed(
  () =>
    ({
      upcoming: 'Your shift hasn’t started yet',
      on: `Reporting opens at ${time(props.shift.window_opens_at, props.shift.timezone)}`,
      reporting: 'Last stretch — wrap up and write your report',
      done: 'Finish your handover report',
    })[phase.value],
);
const percent = computed(() => Math.round(fraction.value * 100));
</script>

<template>
  <div class="flex items-center gap-4">
    <div class="relative size-[112px] shrink-0" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`Shift ${percent}% done, ${center.big} ${center.small}`">
      <svg viewBox="0 0 112 112" class="size-full -rotate-90" aria-hidden="true">
        <circle cx="56" cy="56" :r="R" fill="none" class="stroke-sunken" stroke-width="9" />
        <!-- The reporting window, at the end of the shift -->
        <circle
          cx="56"
          cy="56"
          :r="R"
          fill="none"
          class="stroke-accent/20"
          stroke-width="9"
          :stroke-dasharray="`${(1 - windowFrom) * C} ${C}`"
          :stroke-dashoffset="-windowFrom * C"
        />
        <circle
          cx="56"
          cy="56"
          :r="R"
          fill="none"
          class="stroke-accent transition-[stroke-dasharray] duration-700 ease-out"
          stroke-width="9"
          stroke-linecap="round"
          :stroke-dasharray="`${fraction * C} ${C}`"
        />
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span class="text-[19px] leading-none font-semibold tracking-[-0.02em] tnum">{{ center.big }}</span>
        <span class="mt-1 text-[11.5px] text-ink-3">{{ center.small }}</span>
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <p class="text-[13.5px] font-medium" :class="phase === 'reporting' || phase === 'done' ? 'text-accent-ink' : 'text-ink'">{{ caption }}</p>
      <ol class="mt-2.5 space-y-1.5 text-[12.5px] tnum">
        <li class="flex items-center gap-2">
          <span class="size-2 rounded-full" :class="phase === 'upcoming' ? 'border border-line-strong' : 'bg-accent'" aria-hidden="true" />
          <span class="w-20 text-ink-3">Start</span>
          <span class="text-ink-2">{{ time(shift.starts_at, shift.timezone) }}</span>
        </li>
        <li class="flex items-center gap-2">
          <span class="size-2 rounded-full" :class="phase === 'reporting' || phase === 'done' ? 'bg-accent' : 'bg-accent/25'" aria-hidden="true" />
          <span class="w-20 text-ink-3">Report opens</span>
          <span class="text-ink-2">{{ time(shift.window_opens_at, shift.timezone) }}</span>
        </li>
        <li class="flex items-center gap-2">
          <span class="size-2 rounded-full" :class="phase === 'done' ? 'bg-accent' : 'border border-line-strong'" aria-hidden="true" />
          <span class="w-20 text-ink-3">End</span>
          <span class="text-ink-2">{{ time(shift.ends_at, shift.timezone) }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>
