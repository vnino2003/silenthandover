<script setup lang="ts">
import { computed } from 'vue';
import { api } from '@/lib/api';
import { time } from '@/lib/format';
import { addDays, labelWeekday, rangeDays, type DayMarkKind } from '@/lib/schedule';
import { useAsync } from '@/lib/useAsync';

/** The worker's next seven days at a glance, with pending leave, linking to the full schedule. */
interface Week {
  today: string;
  timezone: string;
  shifts: { id: string; label: string; shift_date: string; starts_at: string; timezone: string }[];
  marks: { day: string; kind: DayMarkKind }[];
  leave: { id: string; start_date: string; end_date: string; status: 'pending' | 'approved' }[];
}
const start = new Date().toISOString().slice(0, 10);
const { data } = useAsync(() => api.get<Week>(`/employee/schedule?from=${start}&to=${addDays(start, 6)}`), [], { refreshMs: 120_000 });
const days = computed(() => {
  const d = data.value;
  if (!d) return [];
  return rangeDays(d.today, addDays(d.today, 6)).map((iso) => {
    const shift = d.shifts.find((s) => s.shift_date === iso);
    const leave = d.leave.find((l) => l.status === 'approved' && iso >= l.start_date && iso <= l.end_date);
    const mark = d.marks.find((m) => m.day === iso);
    return {
      iso,
      kind: leave ? 'leave' : shift ? 'shift' : mark ? 'rest' : 'none',
      text: leave ? 'Leave' : shift ? shift.label : mark ? (mark.kind === 'rest_day' ? 'Rest' : 'Off') : '—',
      sub: shift && !leave ? time(shift.starts_at, shift.timezone) : '',
    };
  });
});
const pending = computed(() => (data.value?.leave ?? []).filter((l) => l.status === 'pending').length);
const TONE = { shift: 'bg-accent text-white', leave: 'bg-violet-soft text-violet', rest: 'bg-info-soft text-info', none: 'bg-sunken text-ink-3' } as const;
</script>

<template>
  <section v-if="data" class="card px-5 py-4" aria-labelledby="week-strip-h">
    <div class="mb-3 flex items-baseline justify-between gap-3">
      <h2 id="week-strip-h" class="text-[15px] font-semibold">Your week</h2>
      <span class="flex items-center gap-3 text-[13px]">
        <RouterLink v-if="pending" to="/leave" class="text-warn hover:underline">{{ pending }} leave pending</RouterLink>
        <RouterLink to="/schedule" class="link">Full schedule</RouterLink>
      </span>
    </div>
    <ol class="stagger grid grid-cols-7 gap-1.5">
      <li v-for="d in days" :key="d.iso" class="min-w-0 text-center">
        <p class="text-[10.5px] font-semibold tracking-[0.06em] uppercase" :class="d.iso === data.today ? 'text-accent-ink' : 'text-ink-3'">{{ d.iso === data.today ? 'Today' : labelWeekday(d.iso) }}</p>
        <div class="mt-1 rounded-md px-1 py-1.5" :class="TONE[d.kind as keyof typeof TONE]">
          <p class="truncate text-[11.5px] font-semibold">{{ d.text }}</p>
          <p class="min-h-[1lh] truncate text-[10.5px] tnum opacity-80">{{ d.sub }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>
