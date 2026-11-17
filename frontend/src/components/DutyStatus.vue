<script setup lang="ts">
import { computed } from 'vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import type { Tone } from '@/components/ui/StatusBadge.vue';
import { day, time } from '@/lib/format';
import { TIME_IN_OPENS_MINUTES, type DutyNow } from '@/lib/duty-now';
import { minutes } from '@/lib/workforce';
import { useAuth } from '@/stores/auth';

/**
 * "Am I on duty, did my time-in count, am I late, when do I time out?" in plain words, for the
 * Attendance page and Today. Late minutes shown after a time-in are the server's (what the DTR uses);
 * before a time-in the page counts them live.
 */
const props = defineProps<{ duty: DutyNow; tz?: string; compact?: boolean }>();
const auth = useAuth();

const view = computed<{ tone: Tone; badge: string; title: string; lines: string[] }>(() => {
  const d = props.duty;
  const t = (iso: string) => time(iso, props.tz);
  if (d.state === 'off') {
    return {
      tone: 'neutral',
      badge: 'Not on duty',
      title: 'You are not on duty right now',
      lines: d.next
        ? [`Next duty: ${d.next.shift_label}, ${day(d.next.scheduled_start, props.tz)} · ${t(d.next.scheduled_start)}–${t(d.next.scheduled_end)}.`, `Time-in opens ${TIME_IN_OPENS_MINUTES / 60} hours before it starts.`]
        : ['No upcoming duty in your schedule.'],
    };
  }
  const r = d.record;
  const range = `${r.shift_label} duty · ${t(r.scheduled_start)}–${t(r.scheduled_end)}`;
  switch (d.state) {
    case 'upcoming':
      return { tone: 'info', badge: 'Starting soon', title: `Your duty starts at ${t(r.scheduled_start)}`, lines: [range, `Starts in ${minutes(d.startsInMinutes)}. Time in when you arrive.`] };
    case 'late':
      return {
        tone: 'bad',
        badge: `Late ${minutes(d.lateMinutes)}`,
        title: 'You are on duty but not timed in',
        lines: [range, `Your duty started at ${t(r.scheduled_start)}. Time in now: the time you scan is recorded, and the minutes late are not paid.`],
      };
    case 'on_duty':
      return {
        tone: r.late_minutes ? 'warn' : 'ok',
        badge: r.late_minutes ? `Timed in · late ${minutes(r.late_minutes)}` : 'Timed in · on time',
        title: `On duty · timed in at ${r.time_in ? t(r.time_in) : '—'}`,
        lines: [range, `You can time out from ${t(r.scheduled_end)}, when your duty ends (in ${minutes(d.endsInMinutes)}).`],
      };
    case 'time_out_due':
      return {
        tone: 'warn',
        badge: 'Time out now',
        title: 'Your duty has ended: time out',
        lines: [
          range,
          `Timed in at ${r.time_in ? t(r.time_in) : '—'}${r.late_minutes ? ` (late ${minutes(r.late_minutes)})` : ''}. Time out now so your DTR is complete.`,
          `Time after ${t(r.scheduled_end)} is not counted unless your ${auth.terms.head} approves it as overtime.`,
        ],
      };
    case 'done':
      return {
        tone: r.late_minutes || r.undertime_minutes ? 'warn' : 'ok',
        badge: 'Duty done',
        title: `Timed in ${r.time_in ? t(r.time_in) : '—'} · timed out ${r.time_out ? t(r.time_out) : '—'}`,
        lines: [
          range,
          [r.late_minutes ? `late ${minutes(r.late_minutes)}` : '', r.undertime_minutes ? `left ${minutes(r.undertime_minutes)} early` : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) ||
            'Complete. Your department head verifies it.',
          ...(r.time_out && Date.parse(r.time_out) > Date.parse(r.scheduled_end) + 60_000 ? [`Time after ${t(r.scheduled_end)} counts only if your ${auth.terms.head} approves it as overtime.`] : []),
        ],
      };
  }
  return { tone: 'neutral', badge: '', title: '', lines: [] };
});
</script>

<template>
  <div class="duty-status" :data-state="duty.state" role="status" aria-live="polite">
    <StatusBadge :tone="view.tone" :label="view.badge" />
    <p class="mt-2 font-semibold" :class="compact ? 'text-[15px]' : 'text-[17px] tracking-[-0.01em]'">{{ view.title }}</p>
    <p v-for="(line, i) in view.lines" :key="i" class="mt-0.5 text-[13.5px] text-ink-2" :class="{ tnum: i === 0 }">{{ line }}</p>
  </div>
</template>
