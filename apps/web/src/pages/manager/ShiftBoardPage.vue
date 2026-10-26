<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { ReportStatus } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, longDate, shiftRange, time } from '@/lib/format';
import type { ShiftView } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * The supervisor's day: who is working right now, every shift of the day in order with its
 * crew, and for each person whether they reported, read their handover and took any items.
 */
interface Assignee {
  employee_id: string;
  employee_name: string;
  report_id: string | null;
  report_status: ReportStatus | null;
  reference_code: string | null;
  is_late: boolean | null;
  override_expires_at: string | null;
  missing: boolean;
  items_taken: number;
  incoming_delivery: { reference: string; acknowledged_at: string | null }[] | null;
}
type Phase = 'upcoming' | 'active' | 'reporting' | 'ended';
type BoardShift = ShiftView & { phase: Phase; assignees: Assignee[] };
interface Board {
  date: string;
  today: string;
  server_now: string;
  timezone: string;
  shifts: BoardShift[];
  counts: { pending_review: number; untaken: number; safety_open: number };
}

const toast = useToast();
const date = ref('');
const { data, loading, error, reload } = useAsync(() => api.get<Board>(`/manager/shift-board${date.value ? `?date=${date.value}` : ''}`), [date]);

// Keep "time left" and the phase fresh without reloading every second.
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 30_000);
const refresh = setInterval(() => void reload(true), 120_000);
onBeforeUnmount(() => {
  clearInterval(tick);
  clearInterval(refresh);
});

const viewingToday = computed(() => !data.value || data.value.date === data.value.today);
function shiftDate(amount: number) {
  const base = new Date(`${data.value?.date ?? new Date().toISOString().slice(0, 10)}T12:00:00`);
  base.setDate(base.getDate() + amount);
  date.value = base.toISOString().slice(0, 10);
}

const onDuty = computed(() => (data.value?.shifts ?? []).filter((s) => s.phase === 'active' && s.assignees.length));
/** Shifts running right now with nobody on them: a gap the supervisor should fill. */
const unstaffedNow = computed(() => (data.value?.shifts ?? []).filter((s) => s.phase === 'active' && !s.assignees.length));
const nextUp = computed(() => (data.value?.shifts ?? []).find((s) => s.phase === 'upcoming') ?? null);
const peopleToday = computed(() => new Set((data.value?.shifts ?? []).flatMap((s) => s.assignees.map((a) => a.employee_id))).size);
const missingCount = computed(() => (data.value?.shifts ?? []).reduce((n, s) => n + s.assignees.filter((a) => a.missing).length, 0));

const PHASE: Record<Phase, { label: string; tone: 'info' | 'accent' | 'neutral' | 'ok' }> = {
  active: { label: 'On duty now', tone: 'info' },
  reporting: { label: 'Writing reports', tone: 'accent' },
  upcoming: { label: 'Coming up', tone: 'neutral' },
  ended: { label: 'Finished', tone: 'ok' },
};

function elapsed(s: BoardShift) {
  const start = new Date(s.starts_at).getTime();
  const end = new Date(s.ends_at).getTime();
  return Math.min(100, Math.max(0, ((now.value - start) / (end - start)) * 100));
}
function left(s: BoardShift) {
  const mins = Math.max(0, Math.round((new Date(s.ends_at).getTime() - now.value) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min left` : `${m} min left`;
}
function startsIn(s: BoardShift) {
  const mins = Math.max(0, Math.round((new Date(s.starts_at).getTime() - now.value) / 60000));
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return `in ${h} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

/** Did this person read the handover meant for them? null = nothing was sent to them. */
function readState(a: Assignee): 'read' | 'unread' | null {
  if (!a.incoming_delivery?.length) return null;
  return a.incoming_delivery.every((d) => d.acknowledged_at) ? 'read' : 'unread';
}
/** Handover summary at the change-over into this shift. */
function handoverInto(s: BoardShift) {
  const sent = s.assignees.filter((a) => readState(a) !== null);
  return { sent: sent.length, read: sent.filter((a) => readState(a) === 'read').length, crew: s.assignees.length };
}
const canAllowLate = (s: BoardShift, a: Assignee) => (s.phase === 'ended' || s.phase === 'reporting') && (!a.report_status || a.report_status === 'draft');

const override = ref<{ shift: BoardShift; person: Assignee } | null>(null);
const minutes = ref(30);
const reason = ref('');
const busy = ref(false);
async function grant() {
  if (!override.value) return;
  busy.value = true;
  try {
    await api.post(`/manager/shifts/${override.value.shift.id}/override`, { employee_id: override.value.person.employee_id, minutes: minutes.value, reason: reason.value });
    toast.ok(`${override.value.person.employee_name} can submit for the next ${minutes.value} minutes`);
    override.value = null;
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader :title="viewingToday ? 'Today' : 'Shifts'" :description="data ? `${longDate(`${data.date}T12:00:00`)} · times in ${data.timezone}` : 'Who is working and how each handover is going.'">
      <div class="flex items-center gap-1">
        <UiButton size="sm" variant="ghost" aria-label="Previous day" @click="shiftDate(-1)">←</UiButton>
        <input :value="data?.date ?? date" type="date" @change="date = ($event.target as HTMLInputElement).value" class="field-input h-9 w-40 py-0 text-[14px]" aria-label="Date" />
        <UiButton size="sm" variant="ghost" aria-label="Next day" @click="shiftDate(1)">→</UiButton>
        <UiButton v-if="!viewingToday" size="sm" @click="date = ''">Today</UiButton>
      </div>
    </PageHeader>

    <StateBlock :loading="loading" :error="error" :empty="false" @retry="reload()">
      <div v-if="data" class="space-y-6">
        <!-- At a glance -->
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div class="card px-4 py-3">
            <p class="text-[12px] text-ink-3">{{ viewingToday ? 'On duty now' : 'Shifts' }}</p>
            <p class="mt-0.5 text-[22px] font-semibold tnum">{{ viewingToday ? onDuty.reduce((n, s) => n + s.assignees.length, 0) : data.shifts.length }}</p>
          </div>
          <div class="card px-4 py-3">
            <p class="text-[12px] text-ink-3">Working {{ viewingToday ? 'today' : 'this day' }}</p>
            <p class="mt-0.5 text-[22px] font-semibold tnum">{{ peopleToday }}</p>
          </div>
          <RouterLink to="/manager" class="card px-4 py-3 hover:bg-sunken" :class="{ 'border-warn/40 bg-warn-soft/40': data.counts.pending_review }">
            <p class="text-[12px] text-ink-3">Reports to review</p>
            <p class="mt-0.5 text-[22px] font-semibold tnum" :class="{ 'text-warn': data.counts.pending_review }">{{ data.counts.pending_review }}</p>
          </RouterLink>
          <RouterLink to="/manager/issues" class="card px-4 py-3 hover:bg-sunken" :class="{ 'border-bad/30 bg-bad-soft/40': missingCount }">
            <p class="text-[12px] text-ink-3">{{ missingCount ? 'Missing reports' : 'Items nobody took' }}</p>
            <p class="mt-0.5 text-[22px] font-semibold tnum" :class="{ 'text-bad': missingCount }">{{ missingCount || data.counts.untaken }}</p>
          </RouterLink>
        </div>

        <!-- Who is working right now -->
        <section v-if="viewingToday" aria-labelledby="now-heading">
          <h2 id="now-heading" class="mb-2 text-[13px] font-semibold tracking-[0.06em] text-ink-3 uppercase">Right now</h2>
          <p v-for="s in unstaffedNow" :key="s.id" class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-bad/30 bg-bad-soft px-4 py-2.5 text-[13.5px] text-bad">
            <span><span class="font-semibold">{{ s.label }}</span> ({{ shiftRange(s) }}) is running with nobody assigned.</span>
            <RouterLink to="/manager/schedule" class="font-medium underline">Add people</RouterLink>
          </p>
          <div v-if="onDuty.length" class="space-y-3">
            <article v-for="s in onDuty" :key="s.id" class="card overflow-hidden border-info/30">
              <div class="flex flex-wrap items-end justify-between gap-2 px-5 pt-4">
                <div>
                  <p class="text-[18px] font-semibold">{{ s.label }}</p>
                  <p class="text-[13px] text-ink-2 tnum">{{ shiftRange(s) }}</p>
                </div>
                <p class="text-[13px] font-medium text-info tnum">{{ left(s) }}</p>
              </div>
              <div class="mx-5 mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                <div class="h-full rounded-full bg-info transition-all" :style="{ width: `${elapsed(s)}%` }" />
              </div>
              <ul v-if="s.assignees.length" class="flex flex-wrap gap-x-6 gap-y-3 px-5 py-4">
                <li v-for="a in s.assignees" :key="a.employee_id" class="flex items-center gap-2.5">
                  <span class="relative grid size-10 place-items-center rounded-full bg-info-soft text-[13px] font-semibold text-info">
                    {{ initials(a.employee_name) }}
                    <span class="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface bg-ok" aria-hidden="true" />
                  </span>
                  <span>
                    <span class="block text-[14.5px] font-semibold">{{ a.employee_name }}</span>
                    <span class="block text-[12.5px] text-ink-3">
                      <template v-if="readState(a) === 'unread'"><span class="text-warn">Hasn’t read the handover</span></template>
                      <template v-else-if="readState(a) === 'read'"><span class="text-ok">Read the handover</span></template>
                      <template v-else>Working</template>
                      <template v-if="a.items_taken"> · took {{ a.items_taken }} item{{ a.items_taken === 1 ? '' : 's' }}</template>
                    </span>
                  </span>
                </li>
              </ul>
            </article>
          </div>
          <div v-else class="card px-5 py-4">
            <p class="text-[15px] font-semibold">Nobody is working right now</p>
            <p v-if="nextUp" class="mt-0.5 text-[13.5px] text-ink-2">
              Next: <span class="font-medium">{{ nextUp.label }}</span> starts at {{ time(nextUp.starts_at, nextUp.timezone) }} ({{ startsIn(nextUp) }}) —
              {{ nextUp.assignees.length ? nextUp.assignees.map((a) => a.employee_name).join(', ') : 'no one assigned yet' }}
            </p>
          </div>
        </section>

        <!-- The whole day in order -->
        <section aria-labelledby="day-heading">
          <div class="mb-2 flex items-baseline justify-between">
            <h2 id="day-heading" class="text-[13px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ viewingToday ? 'Today’s shifts' : 'Shifts on this day' }}</h2>
            <RouterLink to="/manager/schedule" class="text-[13px] link">Change who works</RouterLink>
          </div>
          <div v-if="!data.shifts.length" class="card px-5 py-8 text-center">
            <p class="text-[14px] font-medium">No shifts on this day</p>
            <p class="mt-0.5 text-[13px] text-ink-3">Add people in <RouterLink to="/manager/schedule" class="link">Schedule</RouterLink>.</p>
          </div>
          <ol v-else class="space-y-0">
            <li v-for="(s, i) in data.shifts" :key="s.id">
              <!-- The change-over between two shifts -->
              <div v-if="i > 0" class="flex items-center gap-2 py-2 pl-5 text-[12.5px] text-ink-3">
                <span class="h-5 w-px bg-line-strong" aria-hidden="true" />
                <span>
                  Handover at {{ time(s.starts_at, s.timezone) }}
                  <template v-if="handoverInto(s).sent">· {{ handoverInto(s).read }} of {{ handoverInto(s).sent }} read it</template>
                  <template v-else-if="s.phase !== 'upcoming' && s.assignees.length">· no approved handover yet</template>
                </span>
              </div>
              <article class="card" :class="{ 'border-info/40': s.phase === 'active', 'opacity-80': s.phase === 'ended' }">
                <header class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
                  <div class="flex items-baseline gap-3">
                    <h3 class="text-[15px] font-semibold">{{ s.label }}</h3>
                    <p class="text-[13px] text-ink-3 tnum">{{ shiftRange(s) }}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-[12.5px] text-ink-3">{{ s.assignees.length }} {{ s.assignees.length === 1 ? 'person' : 'people' }}</span>
                    <StatusBadge :tone="PHASE[s.phase].tone" :label="PHASE[s.phase].label" />
                  </div>
                </header>
                <ul v-if="s.assignees.length" class="divide-y divide-line">
                  <li v-for="a in s.assignees" :key="a.employee_id" class="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                    <div class="flex min-w-0 items-center gap-2.5">
                      <span class="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-[11px] font-semibold text-ink-2">{{ initials(a.employee_name) }}</span>
                      <div class="min-w-0">
                        <p class="text-[14px] font-medium">{{ a.employee_name }}</p>
                        <p class="text-[12.5px] text-ink-3">
                          <span v-if="readState(a) === 'read'" class="text-ok">Read the handover</span>
                          <span v-else-if="readState(a) === 'unread'" class="text-warn">Hasn’t read the handover</span>
                          <template v-if="a.items_taken">{{ readState(a) ? ' · ' : '' }}took {{ a.items_taken }} item{{ a.items_taken === 1 ? '' : 's' }}</template>
                          <span v-if="a.override_expires_at" class="text-info"> · late submission allowed until {{ time(a.override_expires_at, s.timezone) }}</span>
                        </p>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <RouterLink v-if="a.report_id && a.report_status !== 'draft'" :to="`/manager/reports/${a.report_id}`"><StatusBadge :report="a.report_status" /></RouterLink>
                      <StatusBadge v-else-if="a.missing" tone="bad" label="Missing report" />
                      <StatusBadge v-else-if="a.report_status === 'draft'" report="draft" />
                      <span v-else class="text-[12.5px] text-ink-3">{{ s.phase === 'upcoming' ? 'Not started' : 'Report not yet due' }}</span>
                      <UiButton v-if="canAllowLate(s, a)" size="sm" variant="ghost" @click="(override = { shift: s, person: a }), (reason = ''), (minutes = 30)">Allow late</UiButton>
                    </div>
                  </li>
                </ul>
                <p v-else class="flex items-center justify-between gap-3 px-5 py-3 text-[13.5px]">
                  <span class="font-medium text-bad">Nobody assigned</span>
                  <RouterLink to="/manager/schedule" class="link">Add people</RouterLink>
                </p>
              </article>
            </li>
          </ol>
        </section>

        <p v-if="data.counts.safety_open" class="rounded-md border border-bad/30 bg-bad-soft px-4 py-3 text-[13.5px] text-bad">
          {{ data.counts.safety_open }} open safety {{ data.counts.safety_open === 1 ? 'problem' : 'problems' }} in your department —
          <RouterLink to="/manager/issues" class="font-medium underline">check the issues list</RouterLink>.
        </p>
      </div>
    </StateBlock>

    <UiDialog :open="Boolean(override)" title="Allow a late submission" :description="override ? `${override.person.employee_name} · ${override.shift.label}` : ''" @close="override = null">
      <div class="space-y-4">
        <UiField v-slot="{ id }" label="For how long">
          <select :id="id" v-model.number="minutes" class="field-input">
            <option :value="15">15 minutes</option>
            <option :value="30">30 minutes</option>
            <option :value="60">1 hour</option>
            <option :value="180">3 hours</option>
            <option :value="720">12 hours</option>
          </select>
        </UiField>
        <UiField v-slot="{ id }" label="Reason" hint="Recorded in the audit log.">
          <input :id="id" v-model="reason" class="field-input" maxlength="500" placeholder="e.g. Emergency at end of shift" />
        </UiField>
        <p v-if="override" class="text-[12.5px] text-ink-3">Expires {{ dateTime(new Date(Date.now() + minutes * 60000)) }}. The report is marked late.</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="override = null">Cancel</UiButton>
        <UiButton variant="primary" :loading="busy" :disabled="reason.trim().length < 3" @click="grant">Allow</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
