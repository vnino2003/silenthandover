<script setup lang="ts">
import { computed } from 'vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { day, time } from '@/lib/format';
import { DTR_STATE, minutes } from '@/lib/workforce';

/** One person's Daily Time Record for a cutoff: totals and the day-by-day lines. */
export interface DtrDay {
  day: string;
  shift: string;
  status: string;
  time_in: string | null;
  time_out: string | null;
  worked_minutes: number;
  late_minutes: number;
  undertime_minutes: number;
  overtime_minutes: number;
  overtime_treatment: string | null;
  paid_leave_minutes: number;
  unpaid_leave_minutes: number;
  verified: boolean;
  split: { day: string; minutes: number }[] | null;
}
export interface Dtr {
  id: string;
  full_name: string;
  job_title: string | null;
  department: string | null;
  version: number;
  state: string;
  totals: Record<string, number>;
  days: DtrDay[];
  blocking_items: number;
  staff_confirmed_at: string | null;
  certified_at: string | null;
  certified_by_name: string | null;
  start_date: string;
  end_date: string;
  period_state: string;
  policy_version: number | null;
}
const props = defineProps<{ dtr: Dtr; tz?: string }>();
const t = computed(() => props.dtr.totals);
const STATUS: Record<string, string> = { present: 'Present', excused: 'On leave', absent: 'Absent', no_show: 'No time-in', incomplete: 'Incomplete', clocked_in: 'On duty', scheduled: 'Upcoming' };
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <StatusBadge :tone="DTR_STATE[dtr.state]?.tone" :label="DTR_STATE[dtr.state]?.label ?? dtr.state" />
      <span class="text-[13px] text-ink-3">Version {{ dtr.version }}<template v-if="dtr.period_state === 'locked'"> · period locked</template></span>
    </div>
    <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Duties</dt><dd class="text-[17px] font-semibold tnum">{{ t.duties ?? 0 }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Worked</dt><dd class="text-[17px] font-semibold tnum">{{ minutes(t.worked_minutes) }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Late and undertime</dt><dd class="text-[17px] font-semibold tnum">{{ minutes((t.late_minutes ?? 0) + (t.undertime_minutes ?? 0)) }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Absences</dt><dd class="text-[17px] font-semibold tnum">{{ t.absences ?? 0 }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Paid leave</dt><dd class="text-[15px] font-semibold tnum">{{ minutes(t.paid_leave_minutes) }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Leave without pay</dt><dd class="text-[15px] font-semibold tnum">{{ minutes(t.unpaid_leave_minutes) }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Overtime (paid / CTO)</dt><dd class="text-[15px] font-semibold tnum">{{ minutes(t.overtime_pay_minutes) }} / {{ minutes(t.compensatory_minutes) }}</dd></div>
      <div class="card px-3 py-2"><dt class="text-[12px] text-ink-3">Night hours</dt><dd class="text-[15px] font-semibold tnum">{{ minutes(t.night_minutes) }}</dd></div>
    </dl>
    <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Daily lines — scroll horizontally to see all columns">
      <table class="w-full min-w-[640px] text-left text-[13.5px]">
        <thead class="border-b border-line text-[12px] text-ink-3">
          <tr><th class="px-4 py-2 font-medium">Day</th><th class="px-3 py-2 font-medium">Duty</th><th class="px-3 py-2 font-medium">In</th><th class="px-3 py-2 font-medium">Out</th><th class="px-3 py-2 font-medium">Late / under</th><th class="px-3 py-2 font-medium">Overtime</th><th class="px-4 py-2 font-medium">Status</th></tr>
        </thead>
        <tbody class="divide-y divide-line tnum">
          <tr v-for="(d, i) in dtr.days" :key="i">
            <td class="px-4 py-2">{{ day(`${d.day}T12:00:00`) }}</td>
            <td class="px-3 py-2">{{ d.shift }}<span v-if="d.split" class="block text-[11.5px] text-ink-3">{{ d.split.map((s) => `${day(`${s.day}T12:00:00`)}: ${minutes(s.minutes)}`).join(' · ') }}</span></td>
            <td class="px-3 py-2">{{ d.time_in ? time(d.time_in, tz) : '—' }}</td>
            <td class="px-3 py-2">{{ d.time_out ? time(d.time_out, tz) : '—' }}</td>
            <td class="px-3 py-2">{{ d.late_minutes || d.undertime_minutes ? minutes(d.late_minutes + d.undertime_minutes) : '—' }}</td>
            <td class="px-3 py-2">{{ d.overtime_minutes ? `${minutes(d.overtime_minutes)} ${d.overtime_treatment === 'pay' ? 'paid' : 'CTO'}` : '—' }}</td>
            <td class="px-4 py-2">{{ STATUS[d.status] ?? d.status }}<span v-if="d.status === 'present'" class="text-ink-3">{{ d.verified ? ' · verified' : ' · not verified' }}</span></td>
          </tr>
          <tr v-if="!dtr.days.length"><td colspan="7" class="px-4 py-6 text-center text-ink-3">No duties in this period.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
