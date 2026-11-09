<script setup lang="ts">
import { IonContent, IonLabel, IonPage, IonSegment, IonSegmentButton } from '@ionic/vue';
import { computed, ref, watch } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api } from '@/lib/api';
import { formatDuration } from '@sh/shared';
import { shiftRange, time } from '@/lib/format';
import {
  addDays, endOfMonth, labelDay, labelDayMonth, labelLongDay, labelMonth, labelWeekday, MARK_LABEL, monthGrid, rangeDays, startOfMonth,
  type DayMarkKind,
} from '@/lib/schedule';
import { useAsync } from '@/lib/useAsync';
import { useNow } from '@/lib/useNow';

/**
 * The employee's own schedule: the next shift first, then the coming days as a list or a month
 * calendar, with rest days, days off and leave marked. Read-only: changes go through the supervisor.
 */
interface MyShift { id: string; label: string; shift_date: string; starts_at: string; ends_at: string; timezone: string; crew_size?: number }
interface Schedule {
  today: string;
  timezone: string;
  next_shift: MyShift | null;
  shifts: MyShift[];
  marks: { day: string; kind: DayMarkKind; note: string }[];
  leave: { id: string; leave_type: string; start_date: string; end_date: string; status: 'pending' | 'approved' }[];
}

const now = useNow(30_000);
const view = ref<'list' | 'calendar'>('list');
const anchor = ref<string | null>(null); // list: first day shown; calendar: any day of the month shown
const listDays = ref(14);
// The department's today: the device date until the server answers.
const today = ref(new Date().toISOString().slice(0, 10));

const range = computed<{ from: string; to: string }>(() => {
  const base = anchor.value ?? today.value;
  return view.value === 'list'
    ? { from: base, to: addDays(base, listDays.value - 1) }
    : { from: monthGrid(base)[0]!, to: monthGrid(base)[41]! };
});
const { data, loading, refreshing, error, reload } = useAsync<Schedule>(
  () => api.get<Schedule>(`/employee/schedule?from=${range.value.from}&to=${range.value.to}`),
  [() => range.value.from, () => range.value.to],
  { refreshMs: 60_000 },
);
watch(data, (d) => d && (today.value = d.today));

function dayInfo(iso: string) {
  const d = data.value;
  if (!d) return { shifts: [], mark: null, leave: null };
  return {
    shifts: d.shifts.filter((s) => s.shift_date === iso),
    mark: d.marks.find((m) => m.day === iso) ?? null,
    // Approved leave wins over a pending request on the same day.
    leave: d.leave.find((l) => l.status === 'approved' && iso >= l.start_date && iso <= l.end_date)
      ?? d.leave.find((l) => iso >= l.start_date && iso <= l.end_date) ?? null,
  };
}
const listRows = computed(() => rangeDays(range.value.from, range.value.to).map((iso) => ({ iso, ...dayInfo(iso) })));
const monthAnchor = computed<string>(() => anchor.value ?? today.value);
const calendarDays = computed(() => monthGrid(monthAnchor.value).map((iso) => ({ iso, inMonth: iso >= startOfMonth(monthAnchor.value) && iso <= endOfMonth(monthAnchor.value), ...dayInfo(iso) })));

function moveMonth(n: number) {
  const d = new Date(`${startOfMonth(monthAnchor.value)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  anchor.value = d.toISOString().slice(0, 10);
}
function setView(v: 'list' | 'calendar') {
  view.value = v;
  anchor.value = null;
  listDays.value = 14;
}

const next = computed(() => data.value?.next_shift ?? null);
const nextState = computed(() => {
  const s = next.value;
  if (!s) return null;
  const start = Date.parse(s.starts_at);
  const end = Date.parse(s.ends_at);
  if (now.value >= start) return { tone: 'text-ok', text: `On now · ${formatDuration(end - now.value)} left` };
  return { tone: 'text-ink-2', text: `Starts in ${formatDuration(start - now.value)}` };
});
const pendingLeave = computed(() => (data.value?.leave ?? []).filter((l) => l.status === 'pending').length);
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-3xl">
            <PageHeader title="My schedule" :description="`Your duty shifts, rest days and leave. Your ${$terms.head} sets the duty schedule; you’re told about every change.`">
              <UiButton to="/leave" variant="primary">Request leave</UiButton>
            </PageHeader>

            <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :lines="5" @retry="reload()">
              <div v-if="data" class="space-y-6">
                <!-- The next shift, first and large -->
                <section class="card flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="next-h">
                  <div v-if="next">
                    <p class="eyebrow">Next shift</p>
                    <h2 id="next-h" class="mt-1 text-[20px] font-semibold tracking-[-0.01em]">{{ next.label }}</h2>
                    <p class="mt-0.5 text-[14.5px] text-ink-2 tnum">{{ labelLongDay(next.shift_date) }} · {{ shiftRange(next) }}</p>
                    <p v-if="nextState" class="mt-1 text-[13px] font-medium tnum" :class="nextState.tone">{{ nextState.text }}</p>
                  </div>
                  <div v-else>
                    <p class="eyebrow">Next shift</p>
                    <h2 id="next-h" class="mt-1 text-[17px] font-semibold">No upcoming shifts yet</h2>
                    <p class="mt-0.5 text-[13.5px] text-ink-3">Your {{ $terms.head }} hasn’t scheduled you yet. You’ll get a notification when they do.</p>
                  </div>
                  <RouterLink v-if="pendingLeave" to="/leave" class="lift shrink-0 rounded-md border border-warn/30 bg-warn-soft/50 px-3.5 py-2.5 text-[13px]">
                    <span class="font-semibold text-warn tnum">{{ pendingLeave }}</span> leave request{{ pendingLeave === 1 ? '' : 's' }} waiting for approval
                  </RouterLink>
                </section>

                <!-- View controls -->
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <IonSegment :value="view" class="sh-segment w-auto" aria-label="Schedule view" @ion-change="setView($event.detail.value as typeof view)">
  <IonSegmentButton v-for="v in [{ k: 'list', l: 'List' }, { k: 'calendar', l: 'Calendar' }] as const" :key="v.k" :value="v.k"><IonLabel>{{ v.l }}</IonLabel></IonSegmentButton>
</IonSegment>
                  <div v-if="view === 'calendar'" class="flex items-center gap-1">
                    <UiButton size="sm" variant="ghost" aria-label="Previous month" @click="moveMonth(-1)">←</UiButton>
                    <span class="min-w-36 text-center text-[14px] font-semibold">{{ labelMonth(monthAnchor) }}</span>
                    <UiButton size="sm" variant="ghost" aria-label="Next month" @click="moveMonth(1)">→</UiButton>
                  </div>
                  <ul class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3" aria-label="Legend">
                    <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-accent" />Shift</li>
                    <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-info-soft ring-1 ring-info/30" />Rest day / day off</li>
                    <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-violet-soft ring-1 ring-violet/30" />Leave</li>
                  </ul>
                </div>

                <!-- List: one row per day -->
                <ol v-if="view === 'list'" class="stagger card divide-y divide-line" aria-label="Coming days">
                  <li v-for="d in listRows" :key="d.iso" class="flex gap-4 px-5 py-3" :class="{ 'bg-accent-soft/30': d.iso === data.today }">
                    <div class="w-16 shrink-0">
                      <p class="text-[12px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ d.iso === data.today ? 'Today' : labelWeekday(d.iso) }}</p>
                      <p class="text-[14px] font-medium tnum">{{ labelDayMonth(d.iso) }}</p>
                    </div>
                    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <span v-for="s in d.shifts" :key="s.id" class="rounded-md bg-accent px-2.5 py-1 text-[13px] font-medium text-white tnum">
                        {{ s.label }} · {{ time(s.starts_at, s.timezone) }} – {{ time(s.ends_at, s.timezone) }}
                      </span>
                      <span v-if="d.leave" class="rounded-md px-2.5 py-1 text-[13px] font-medium" :class="d.leave.status === 'approved' ? 'bg-violet-soft text-violet' : 'border border-dashed border-violet/40 text-violet'">
                        {{ d.leave.leave_type }}{{ d.leave.status === 'pending' ? ' · pending' : '' }}
                      </span>
                      <span v-if="d.mark" class="rounded-md bg-info-soft px-2.5 py-1 text-[13px] font-medium text-info" :title="d.mark.note || undefined">{{ MARK_LABEL[d.mark.kind] }}</span>
                      <span v-if="!d.shifts.length && !d.leave && !d.mark" class="text-[13px] text-ink-3">Not scheduled</span>
                    </div>
                  </li>
                </ol>
                <div v-if="view === 'list'" class="flex justify-center">
                  <UiButton size="sm" variant="ghost" @click="listDays += 14">Show 2 more weeks</UiButton>
                </div>

                <!-- Calendar: the month at a glance -->
                <div v-else class="card overflow-hidden">
                  <div class="grid grid-cols-7 border-b border-line bg-canvas/60 text-center text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                    <span v-for="w in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']" :key="w" class="py-2">{{ w }}</span>
                  </div>
                  <div class="grid grid-cols-7">
                    <div
                      v-for="d in calendarDays"
                      :key="d.iso"
                      class="min-h-20 border-r border-b border-line p-1.5 text-[11.5px] [&:nth-child(7n)]:border-r-0"
                      :class="[d.inMonth ? '' : 'bg-canvas/50 text-ink-3', d.iso === data.today ? 'bg-accent-soft/40' : '']"
                      :aria-label="labelDay(d.iso)"
                    >
                      <p class="mb-1 font-semibold tnum" :class="d.iso === data.today ? 'text-accent-ink' : ''">{{ Number(d.iso.slice(8)) }}</p>
                      <p v-for="s in d.shifts" :key="s.id" class="mb-0.5 truncate rounded bg-accent px-1 py-0.5 font-medium text-white">{{ s.label }}</p>
                      <p v-if="d.leave" class="mb-0.5 truncate rounded px-1 py-0.5 font-medium" :class="d.leave.status === 'approved' ? 'bg-violet-soft text-violet' : 'border border-dashed border-violet/40 text-violet'">
                        {{ d.leave.status === 'approved' ? 'Leave' : 'Pending' }}
                      </p>
                      <p v-if="d.mark" class="truncate rounded bg-info-soft px-1 py-0.5 font-medium text-info">{{ d.mark.kind === 'rest_day' ? 'Rest' : 'Off' }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
