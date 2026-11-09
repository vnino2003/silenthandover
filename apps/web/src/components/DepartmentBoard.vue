<script setup lang="ts">
import { toggleIn } from '@/lib/toggleIn';
import { IonChip, IonInput, IonItem, IonLabel, IonSegment, IonSegmentButton, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref, watch } from 'vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api, errorMessage } from '@/lib/api';
import { time } from '@/lib/format';
import {
  addDays, endOfMonth, labelDay, labelDayMonth, labelLongDay, labelMonth, labelWeekday, MARK_LABEL, monthGrid, rangeDays, startOfMonth, startOfWeek,
  type DayMarkKind,
} from '@/lib/schedule';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * The department schedule board: who works when, who is resting or on leave, how well each
 * shift is covered, and what needs attention. Supervisors edit it in place (assign, remove,
 * rest days); administrators see it read-only.
 */
const props = defineProps<{ endpoint: string; readonly?: boolean }>();

interface Employee { id: string; full_name: string; job_title: string | null; photo_version: number | null }
interface Pattern { id: string; name: string; start_time: string; end_time: string; min_staff: number }
interface Shift { id: string; label: string; template_id: string | null; shift_date: string; starts_at: string; ends_at: string; status: 'scheduled' | 'cancelled'; min_staff: number; assignees: string[] }
interface Mark { employee_id: string; day: string; kind: DayMarkKind; note: string }
interface Leave { id: string; employee_id: string; leave_type: string; start_date: string; end_date: string; status: 'pending' | 'approved' }
interface Conflict { kind: 'understaffed' | 'pending_leave' | 'rest_day'; shift_id: string | null; day: string; employee_id: string | null; text: string }
interface Board {
  department: { id: string; name: string; timezone: string; today: string };
  employees: Employee[];
  patterns: Pattern[];
  shifts: Shift[];
  marks: Mark[];
  leave: Leave[];
  conflicts: Conflict[];
}

const toast = useToast();
const view = ref<'day' | 'week' | 'month'>('week');
const anchor = ref<string | null>(null);
const employeeFilter = ref('');
const shiftFilter = ref('');

// The department's today: the device date until the server answers (kept separate from the data
// so the date range can be worked out before anything is loaded).
const today = ref(new Date().toISOString().slice(0, 10));
const focus = computed<string>(() => anchor.value ?? today.value);
const range = computed<{ from: string; to: string }>(() => {
  if (view.value === 'day') return { from: focus.value, to: focus.value };
  if (view.value === 'week') return { from: startOfWeek(focus.value), to: addDays(startOfWeek(focus.value), 6) };
  const grid = monthGrid(focus.value);
  return { from: grid[0]!, to: grid[41]! };
});
const sep = computed(() => (props.endpoint.includes('?') ? '&' : '?'));
const { data, loading, refreshing, error, reload } = useAsync<Board>(
  () => api.get<Board>(`${props.endpoint}${sep.value}from=${range.value.from}&to=${range.value.to}`),
  [() => range.value.from, () => range.value.to, () => props.endpoint],
  { refreshMs: 60_000 },
);
watch(data, (d) => d && (today.value = d.department.today));

function move(n: number) {
  if (view.value === 'day') anchor.value = addDays(focus.value, n);
  else if (view.value === 'week') anchor.value = addDays(focus.value, n * 7);
  else {
    const d = new Date(`${startOfMonth(focus.value)}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    anchor.value = d.toISOString().slice(0, 10);
  }
}
const title = computed(() =>
  view.value === 'day' ? labelLongDay(focus.value) : view.value === 'week' ? `${labelDayMonth(range.value.from)} – ${labelDayMonth(range.value.to)}` : labelMonth(focus.value),
);
const openDay = (iso: string) => {
  anchor.value = iso;
  view.value = 'day';
};

// ---- Lookups
const employees = computed(() => (data.value?.employees ?? []).filter((e) => !employeeFilter.value || e.id === employeeFilter.value));
const nameOf = (id: string) => data.value?.employees.find((e) => e.id === id)?.full_name ?? 'Someone';
const firstName = (id: string) => nameOf(id).split(' ')[0];
const shiftMatches = (s: Shift) => !shiftFilter.value || s.template_id === shiftFilter.value;
const shiftsOn = (iso: string) => (data.value?.shifts ?? []).filter((s) => s.shift_date === iso && s.status === 'scheduled' && shiftMatches(s));
const shiftsOf = (emp: string, iso: string) => shiftsOn(iso).filter((s) => s.assignees.includes(emp));
const markOf = (emp: string, iso: string) => data.value?.marks.find((m) => m.employee_id === emp && m.day === iso) ?? null;
const leaveOf = (emp: string, iso: string) => {
  const all = (data.value?.leave ?? []).filter((l) => l.employee_id === emp && iso >= l.start_date && iso <= l.end_date);
  return all.find((l) => l.status === 'approved') ?? all[0] ?? null;
};
type Cover = 'ok' | 'short' | 'empty' | 'none';
const coverOf = (s: Shift): Cover => (s.min_staff === 0 ? 'none' : s.assignees.length === 0 ? 'empty' : s.assignees.length < s.min_staff ? 'short' : 'ok');
const COVER_CLASS: Record<Cover, string> = {
  ok: 'bg-ok-soft text-ok',
  short: 'bg-warn-soft text-warn',
  empty: 'bg-bad-soft text-bad',
  none: 'bg-sunken text-ink-3',
};
const days = computed(() => rangeDays(range.value.from, range.value.to));
const monthDays = computed(() => monthGrid(focus.value).map((iso) => ({ iso, inMonth: iso >= startOfMonth(focus.value) && iso <= endOfMonth(focus.value) })));
const onLeaveOn = (iso: string) => (data.value?.employees ?? []).filter((e) => leaveOf(e.id, iso)?.status === 'approved');
const pendingOn = (iso: string) => (data.value?.employees ?? []).filter((e) => leaveOf(e.id, iso)?.status === 'pending');
const restingOn = (iso: string) => (data.value?.employees ?? []).filter((e) => markOf(e.id, iso) && !shiftsOf(e.id, iso).length);
const conflicts = computed(() =>
  (data.value?.conflicts ?? []).filter((c) => (!employeeFilter.value || c.employee_id === employeeFilter.value || !c.employee_id) && (!shiftFilter.value || !c.shift_id || shiftMatches(data.value!.shifts.find((s) => s.id === c.shift_id)!))),
);
const shortCount = computed(() => conflicts.value.filter((c) => c.kind === 'understaffed').length);

// ---- Editing one person's day (supervisors only)
const cell = ref<{ emp: Employee; day: string } | null>(null);
const busy = ref<string | null>(null);
const restForm = ref<{ weekdays: number[]; to: string } | null>(null);
function openCell(emp: Employee, day: string) {
  if (props.readonly) return;
  cell.value = { emp, day };
  restForm.value = null;
}
async function act(key: string, fn: () => Promise<unknown>, ok: string) {
  busy.value = key;
  try {
    await fn();
    toast.ok(ok);
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
const assign = (s: Shift) =>
  act(`add-${s.id}`, async () => {
    const res = await api.post<{ warnings?: string[] }>(`/manager/schedule/${s.id}/assignments`, { employee_id: cell.value!.emp.id });
    for (const w of res.warnings ?? []) toast.info(w);
  }, `${firstName(cell.value!.emp.id)} added to ${s.label}`);
const unassign = (s: Shift) => act(`rm-${s.id}`, () => api.del(`/manager/schedule/${s.id}/assignments/${cell.value!.emp.id}`), `Removed from ${s.label}`);
const mark = (kind: DayMarkKind | null) =>
  act(`mark-${kind}`, () => api.put('/manager/day-marks', { employee_id: cell.value!.emp.id, day: cell.value!.day, kind, note: '' }), kind ? `Marked as ${MARK_LABEL[kind].toLowerCase()}` : 'Day cleared');
const saveRestDays = () =>
  act('rest', async () => {
    const r = await api.post<{ added: number }>('/manager/rest-days', { employee_id: cell.value!.emp.id, from: cell.value!.day, to: restForm.value!.to, weekdays: restForm.value!.weekdays });
    toast.info(`${r.added} rest day${r.added === 1 ? '' : 's'} added`);
    restForm.value = null;
  }, 'Weekly rest days saved');
const WEEKDAYS = [
  { v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }, { v: 7, l: 'Sun' },
];
const cellShifts = computed(() => (cell.value ? shiftsOn(cell.value.day) : []));
const cellLeave = computed(() => (cell.value ? leaveOf(cell.value.emp.id, cell.value.day) : null));
const cellMark = computed(() => (cell.value ? markOf(cell.value.emp.id, cell.value.day) : null));
</script>

<template>
  <div>
    <!-- Controls: view, dates, filters -->
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <IonSegment :value="view" class="sh-segment w-auto" aria-label="Board view" @ion-change="view = $event.detail.value as typeof view">
  <IonSegmentButton v-for="v in [{ k: 'day', l: 'Day' }, { k: 'week', l: 'Week' }, { k: 'month', l: 'Month' }] as const" :key="v.k" :value="v.k"><IonLabel>{{ v.l }}</IonLabel></IonSegmentButton>
</IonSegment>
        <UiButton size="sm" variant="ghost" aria-label="Previous" @click="move(-1)">←</UiButton>
        <UiButton size="sm" variant="ghost" @click="anchor = null">Today</UiButton>
        <UiButton size="sm" variant="ghost" aria-label="Next" @click="move(1)">→</UiButton>
        <h3 class="ml-1 text-[15px] font-semibold tnum">{{ title }}</h3>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <IonSelect v-model="employeeFilter" class="field-input h-9 w-44 py-0 text-[13.5px]" aria-label="Staff member" interface="popover">
          <IonSelectOption value="">Everyone</IonSelectOption>
          <IonSelectOption v-for="e in data?.employees ?? []" :key="e.id" :value="e.id">{{ e.full_name }}</IonSelectOption>
        </IonSelect>
        <IonSelect v-model="shiftFilter" class="field-input h-9 w-40 py-0 text-[13.5px]" aria-label="Shift" interface="popover">
          <IonSelectOption value="">All shifts</IonSelectOption>
          <IonSelectOption v-for="p in data?.patterns ?? []" :key="p.id" :value="p.id">{{ p.name }}</IonSelectOption>
        </IonSelect>
      </div>
    </div>

    <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :lines="6" @retry="reload()">
      <div v-if="data" class="space-y-4">
        <!-- Needs attention -->
        <details v-if="conflicts.length" class="card group border-warn/30" :open="conflicts.length <= 6">
          <summary class="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-[13.5px]">
            <span class="font-semibold text-warn">{{ conflicts.length }} thing{{ conflicts.length === 1 ? '' : 's' }} need attention<template v-if="shortCount"> · {{ shortCount }} understaffed</template></span>
            <span class="text-[12px] text-ink-3 group-open:hidden">Show</span>
          </summary>
          <ul class="stagger divide-y divide-line border-t border-line text-[13px]">
            <li v-for="(c, i) in conflicts.slice(0, 30)" :key="i">
              <IonItem button :detail="false" lines="none" class="sh-row" @click="openDay(c.day)"><div class="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-sunken">
                <span class="w-24 shrink-0 text-ink-3 tnum">{{ labelDay(c.day) }}</span>
                <span class="size-2 shrink-0 rounded-full" :class="c.kind === 'understaffed' ? 'bg-bad' : c.kind === 'pending_leave' ? 'bg-violet' : 'bg-info'" aria-hidden="true" />
                <span class="min-w-0 flex-1">{{ c.text }}</span>
              </div></IonItem>
            </li>
          </ul>
        </details>

        <!-- Week: one row per person -->
        <div v-if="view === 'week'" class="card overflow-x-auto">
          <table class="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr class="border-b border-line">
                <th class="sticky left-0 z-10 w-52 border-r border-line bg-surface px-4 py-3 text-[12px] font-semibold text-ink-3">{{ data.employees.length }} people</th>
                <th v-for="d in days" :key="d" class="px-2 py-2 text-center" :class="{ 'bg-accent-soft/40': d === today }">
                  <button type="button" class="mx-auto block rounded px-2 py-0.5 hover:bg-sunken" @click="openDay(d)">
                    <span class="block text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{{ labelWeekday(d) }}</span>
                    <span class="block text-[14px] font-semibold tnum" :class="d === today ? 'text-accent-ink' : ''">{{ Number(d.slice(8)) }}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody class="stagger divide-y divide-line">
              <tr v-for="e in employees" :key="e.id" class="align-top">
                <th class="sticky left-0 z-10 border-r border-line bg-surface px-4 py-2.5">
                  <span class="flex items-center gap-2.5">
                    <UserAvatar :id="e.id" :name="e.full_name" :version="e.photo_version" :size="30" />
                    <span class="min-w-0">
                      <span class="block truncate text-[13.5px] font-semibold">{{ e.full_name }}</span>
                      <span class="block truncate text-[12px] font-normal text-ink-3">{{ e.job_title ?? '—' }}</span>
                    </span>
                  </span>
                </th>
                <td v-for="d in days" :key="d" class="p-1" :class="{ 'bg-accent-soft/30': d === today }">
                  <IonItem button :detail="false" lines="none" class="sh-row"
                   
                    :class="readonly ? 'cursor-default' : 'lift hover:bg-sunken'"
                    :aria-label="`${e.full_name}, ${labelDay(d)}`"
                    @click="openCell(e, d)"
                  ><div class="flex min-h-14 w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-[11.5px]">
                    <span v-for="s in shiftsOf(e.id, d)" :key="s.id" class="truncate rounded bg-accent px-1.5 py-0.5 font-medium text-white tnum">{{ s.label }} {{ time(s.starts_at, data.department.timezone) }}</span>
                    <span v-if="leaveOf(e.id, d)" class="truncate rounded px-1.5 py-0.5 font-medium" :class="leaveOf(e.id, d)!.status === 'approved' ? 'bg-violet-soft text-violet' : 'border border-dashed border-violet/50 text-violet'">
                      {{ leaveOf(e.id, d)!.status === 'approved' ? 'On leave' : 'Leave?' }}
                    </span>
                    <span v-if="markOf(e.id, d)" class="truncate rounded bg-info-soft px-1.5 py-0.5 font-medium text-info">{{ MARK_LABEL[markOf(e.id, d)!.kind] }}</span>
                    <span v-if="!shiftsOf(e.id, d).length && !leaveOf(e.id, d) && !markOf(e.id, d)" class="px-1.5 py-0.5 text-ink-3">—</span>
                  </div></IonItem>
                </td>
              </tr>
              <tr v-if="!employees.length"><td colspan="8" class="px-5 py-8 text-center text-[13px] text-ink-3">No active staff in this department.</td></tr>
            </tbody>
            <!-- Coverage per shift and day -->
            <tfoot class="border-t-2 border-line bg-canvas/60">
              <tr v-for="p in (data.patterns as Pattern[]).filter((p) => !shiftFilter || p.id === shiftFilter)" :key="p.id">
                <th class="sticky left-0 z-10 border-r border-line bg-canvas px-4 py-2 text-[12px] font-semibold text-ink-2">
                  {{ p.name }} <span class="font-normal text-ink-3 tnum">· min {{ p.min_staff }}</span>
                </th>
                <td v-for="d in days" :key="d" class="p-1 text-center">
                  <template v-for="s in shiftsOn(d).filter((x) => x.template_id === p.id)" :key="s.id">
                    <span class="inline-block rounded-full px-2 py-0.5 text-[11.5px] font-semibold tnum" :class="COVER_CLASS[coverOf(s)]">{{ s.assignees.length }} / {{ s.min_staff }}</span>
                  </template>
                  <span v-if="!shiftsOn(d).some((x) => x.template_id === p.id)" class="text-[11.5px] text-ink-3">—</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Day: each shift with its crew, and who is off -->
        <div v-else-if="view === 'day'" class="space-y-3">
          <article v-for="s in shiftsOn(focus)" :key="s.id" class="card">
            <header class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
              <div class="flex items-baseline gap-3">
                <h4 class="text-[15px] font-semibold">{{ s.label }}</h4>
                <p class="text-[13px] text-ink-3 tnum">{{ time(s.starts_at, data.department.timezone) }} – {{ time(s.ends_at, data.department.timezone) }}</p>
              </div>
              <span class="rounded-full px-2.5 py-0.5 text-[12px] font-semibold tnum" :class="COVER_CLASS[coverOf(s)]">
                {{ s.assignees.length }} of {{ s.min_staff }} {{ coverOf(s) === 'ok' ? '· covered' : coverOf(s) === 'none' ? '' : '· understaffed' }}
              </span>
            </header>
            <ul v-if="s.assignees.filter((a) => !employeeFilter || a === employeeFilter).length" class="stagger flex flex-wrap gap-x-5 gap-y-2 px-5 py-3">
              <li v-for="a in s.assignees.filter((x) => !employeeFilter || x === employeeFilter)" :key="a" class="flex items-center gap-2">
                <UserAvatar :id="a" :name="nameOf(a)" :version="data.employees.find((e) => e.id === a)?.photo_version" :size="28" />
                <span class="text-[13.5px] font-medium">{{ nameOf(a) }}</span>
                <span v-if="leaveOf(a, focus)?.status === 'pending'" class="text-[12px] text-violet">pending leave</span>
              </li>
            </ul>
            <p v-else class="px-5 py-3 text-[13px] font-medium text-bad">Nobody assigned</p>
          </article>
          <p v-if="!shiftsOn(focus).length" class="card px-5 py-6 text-center text-[13.5px] text-ink-3">No shifts on this day.</p>
          <div class="grid gap-3 sm:grid-cols-3">
            <div v-for="g in [
              { title: 'On leave', people: onLeaveOn(focus), tone: 'text-violet' },
              { title: 'Leave pending', people: pendingOn(focus), tone: 'text-violet' },
              { title: 'Rest day / day off', people: restingOn(focus), tone: 'text-info' },
            ]" :key="g.title" class="card px-4 py-3">
              <p class="text-[12px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ g.title }} · {{ g.people.length }}</p>
              <p class="mt-1 text-[13.5px]" :class="g.people.length ? g.tone : 'text-ink-3'">{{ g.people.length ? g.people.map((p) => p.full_name).join(', ') : 'Nobody' }}</p>
            </div>
          </div>
        </div>

        <!-- Month: coverage at a glance; a day opens the day view -->
        <div v-else class="card overflow-hidden">
          <div class="grid grid-cols-7 border-b border-line bg-canvas/60 text-center text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
            <span v-for="w in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']" :key="w" class="py-2">{{ w }}</span>
          </div>
          <div class="grid grid-cols-7">
            <button
              v-for="d in monthDays"
              :key="d.iso"
              type="button"
              class="min-h-24 border-r border-b border-line p-1.5 text-left text-[11.5px] hover:bg-sunken [&:nth-child(7n)]:border-r-0"
              :class="[d.inMonth ? '' : 'bg-canvas/50 text-ink-3', d.iso === today ? 'bg-accent-soft/40' : '']"
              :aria-label="`Open ${labelDay(d.iso)}`"
              @click="openDay(d.iso)"
            >
              <p class="mb-1 font-semibold tnum" :class="d.iso === today ? 'text-accent-ink' : ''">{{ Number(d.iso.slice(8)) }}</p>
              <span class="flex flex-wrap gap-0.5">
                <span v-for="s in shiftsOn(d.iso)" :key="s.id" class="rounded px-1 font-semibold tnum" :class="COVER_CLASS[coverOf(s)]" :title="`${s.label}: ${s.assignees.length} of ${s.min_staff}`">{{ s.label.slice(0, 1) }} {{ s.assignees.length }}/{{ s.min_staff }}</span>
              </span>
              <p v-if="onLeaveOn(d.iso).length" class="mt-1 truncate text-violet">{{ onLeaveOn(d.iso).length }} on leave</p>
              <p v-if="pendingOn(d.iso).length" class="truncate text-violet/80">{{ pendingOn(d.iso).length }} pending</p>
            </button>
          </div>
        </div>

        <ul class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3" aria-label="Legend">
          <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-accent" />Shift</li>
          <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-violet-soft ring-1 ring-violet/30" />Approved leave</li>
          <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm border border-dashed border-violet/50" />Pending leave (not yet off)</li>
          <li class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-info-soft ring-1 ring-info/30" />Rest day / day off</li>
          <li class="flex items-center gap-1.5"><span class="rounded-full bg-ok-soft px-1.5 text-ok">2 / 2</span> covered · <span class="rounded-full bg-warn-soft px-1.5 text-warn">1 / 2</span> short · <span class="rounded-full bg-bad-soft px-1.5 text-bad">0 / 2</span> empty</li>
        </ul>
      </div>
    </StateBlock>

    <!-- One person, one day -->
    <UiDialog :open="Boolean(cell)" :title="cell ? cell.emp.full_name : ''" :description="cell ? labelLongDay(cell.day) : undefined" @close="cell = null">
      <div v-if="cell" class="space-y-5">
        <p v-if="cellLeave" class="rounded-md px-3 py-2 text-[13px]" :class="cellLeave.status === 'approved' ? 'bg-violet-soft text-violet' : 'border border-dashed border-violet/40 text-violet'">
          {{ cellLeave.leave_type }} — {{ cellLeave.status === 'approved' ? 'approved; can’t be scheduled this day' : 'pending; not approved yet' }}
        </p>
        <section>
          <h4 class="mb-2 text-[13.5px] font-semibold">Shifts this day</h4>
          <ul class="divide-y divide-line rounded-md border border-line">
            <li v-for="s in cellShifts" :key="s.id" class="flex items-center justify-between gap-3 px-3 py-2.5">
              <span class="min-w-0">
                <span class="block text-[13.5px] font-medium">{{ s.label }}</span>
                <span class="block text-[12px] text-ink-3 tnum">{{ time(s.starts_at, data!.department.timezone) }} – {{ time(s.ends_at, data!.department.timezone) }} · {{ s.assignees.length }} of {{ s.min_staff }}</span>
              </span>
              <UiButton v-if="s.assignees.includes(cell.emp.id)" size="sm" variant="ghost" :loading="busy === `rm-${s.id}`" @click="unassign(s)">Remove</UiButton>
              <UiButton v-else size="sm" :disabled="cellLeave?.status === 'approved'" :loading="busy === `add-${s.id}`" @click="assign(s)">Add</UiButton>
            </li>
            <li v-if="!cellShifts.length" class="px-3 py-3 text-[13px] text-ink-3">No shifts scheduled this day.</li>
          </ul>
        </section>
        <section>
          <h4 class="mb-2 text-[13.5px] font-semibold">Rest and days off</h4>
          <div class="flex flex-wrap gap-2">
            <UiButton size="sm" :variant="cellMark?.kind === 'rest_day' ? 'primary' : 'secondary'" :loading="busy === 'mark-rest_day'" @click="mark('rest_day')">Rest day</UiButton>
            <UiButton size="sm" :variant="cellMark?.kind === 'day_off' ? 'primary' : 'secondary'" :loading="busy === 'mark-day_off'" @click="mark('day_off')">Day off</UiButton>
            <UiButton v-if="cellMark" size="sm" variant="ghost" :loading="busy === 'mark-null'" @click="mark(null)">Clear</UiButton>
            <UiButton v-if="!restForm" size="sm" variant="ghost" @click="restForm = { weekdays: [cell.day ? ((new Date(`${cell.day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 : 7], to: addDays(cell.day, 27) }">Repeat weekly…</UiButton>
          </div>
          <div v-if="restForm" class="mt-3 space-y-3 rounded-md border border-line p-3">
            <p class="text-[13px] text-ink-2">Rest days for {{ firstName(cell.emp.id) }} every week, from {{ labelDay(cell.day) }}:</p>
            <div class="grid grid-cols-7 gap-1">
              <IonChip
                v-for="w in WEEKDAYS"
                :key="w.v"
                role="checkbox"
                :aria-checked="restForm.weekdays.includes(w.v)"
                :outline="!restForm.weekdays.includes(w.v)"
                :color="restForm.weekdays.includes(w.v) ? 'primary' : undefined"
                class="m-0 h-8 justify-center text-[11.5px] font-medium"
                @click="restForm.weekdays = toggleIn(restForm.weekdays, w.v)"
              >{{ w.l }}</IonChip>
            </div>
            <UiField v-slot="{ id, labelledby }" label="Until"><IonInput :id="id" :aria-labelledby="labelledby" v-model="restForm.to" type="date" :min="cell.day" :max="addDays(cell.day, 120)" class="field-input"  /></UiField>
            <div class="flex justify-end gap-2">
              <UiButton size="sm" variant="ghost" @click="restForm = null">Cancel</UiButton>
              <UiButton size="sm" variant="primary" :disabled="!restForm.weekdays.length" :loading="busy === 'rest'" @click="saveRestDays">Save rest days</UiButton>
            </div>
          </div>
        </section>
      </div>
      <template #footer>
        <UiButton variant="primary" @click="cell = null">Done</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
