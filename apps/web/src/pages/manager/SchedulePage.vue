<script setup lang="ts">
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { day, shiftRange, time } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface ShiftType {
  id: string;
  team_id: string | null;
  name: string;
  start_time: string;
  end_time: string;
  overnight: boolean;
  window_open_minutes: number;
  grace_minutes: number;
  allow_early_draft: boolean;
  is_active: boolean;
  weekdays: number[];
}
interface ScheduleSettings {
  department_name: string;
  timezone: string;
  operating_start_time: string;
  operating_end_time: string;
  operates_24_hours: boolean;
}
interface Shift {
  id: string;
  label: string;
  shift_date: string;
  timezone: string;
  status: 'scheduled' | 'cancelled';
  starts_at: string;
  ends_at: string;
  window_opens_at: string;
  window_closes_at: string;
  supervisor_id: string | null;
  assignees: { employee_id: string; full_name: string }[];
}

const auth = useAuth();
const toast = useToast();
const me = computed(() => auth.profile?.id ?? null);

const localIso = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dateNumber = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${dateNumber}`;
};
const addDays = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};
const startOfWeek = (date: Date) => {
  const monday = new Date(date);
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
};
const todayIso = localIso(new Date());
const weekStart = ref(startOfWeek(new Date()));
const scheduleView = ref<'calendar' | 'people'>('calendar');
const range = computed(() => ({ from: localIso(weekStart.value), to: localIso(addDays(weekStart.value, 6)) }));
const weekTitle = computed(() => {
  const end = addDays(weekStart.value, 6);
  const startText = weekStart.value.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  const endText = end.toLocaleDateString('en-PH', {
    month: weekStart.value.getMonth() === end.getMonth() ? undefined : 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${startText} – ${endText}`;
});
function moveWeek(amount: number) {
  weekStart.value = addDays(weekStart.value, amount * 7);
}
function goToday() {
  weekStart.value = startOfWeek(new Date());
}

const types = useAsync(() => api.get<ShiftType[]>('/manager/templates'));
const settings = useAsync(() => api.get<ScheduleSettings>('/manager/schedule/settings'));
const shifts = useAsync(() => api.get<Shift[]>(`/manager/schedule?from=${range.value.from}&to=${range.value.to}`), [weekStart]);
const activeTypes = computed(() => (types.data.value ?? []).filter((type) => type.is_active));
const inactiveTypes = computed(() => (types.data.value ?? []).filter((type) => !type.is_active));
const showInactiveTypes = ref(false);
const staff = useAsync(() => api.get<{ id: string; full_name: string; role: string }[]>('/department/staff'));
const workers = computed(() => (staff.data.value ?? []).filter((p) => p.role === 'employee'));
const shiftsByDate = computed(() => {
  const groups = new Map<string, Shift[]>();
  for (const shift of shifts.data.value ?? []) groups.set(shift.shift_date, [...(groups.get(shift.shift_date) ?? []), shift]);
  for (const list of groups.values()) list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return groups;
});
const calendarDays = computed(() => {
  const label = new Intl.DateTimeFormat('en-PH', { weekday: 'short' });
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart.value, index);
    const iso = localIso(date);
    return { iso, label: label.format(date), dateNumber: date.getDate(), isToday: iso === todayIso, shifts: shiftsByDate.value.get(iso) ?? [] };
  });
});
const rosterRows = computed(() =>
  workers.value.map((worker) => ({
    ...worker,
    days: calendarDays.value.map((calendarDay) => calendarDay.shifts.filter((shift) => shift.assignees.some((assignee) => assignee.employee_id === worker.id))),
  })),
);

/** "14:00" → "2:00 PM" */
function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function minus(hhmm: string, mins: number) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const t = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return clock(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
}
const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
] as const;
function minutesBetween(start: string, end: string) {
  const [sh, sm] = start.split(':').map(Number) as [number, number];
  const [eh, em] = end.split(':').map(Number) as [number, number];
  const from = sh * 60 + sm;
  const to = eh * 60 + em;
  return to <= from ? to + 1440 - from : to - from;
}
function durationLabel(start: string, end: string) {
  const minutes = minutesBetween(start, end);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours ? `${hours} hr${hours === 1 ? '' : 's'}` : ''}${hours && remainder ? ' ' : ''}${remainder ? `${remainder} min` : ''}`;
}
function daysLabel(days: number[]) {
  const normalized = [...days].sort((a, b) => a - b).join(',');
  if (normalized === '1,2,3,4,5,6,7') return 'Every day';
  if (normalized === '1,2,3,4,5') return 'Weekdays';
  if (normalized === '6,7') return 'Weekends';
  return WEEKDAYS.filter((weekday) => days.includes(weekday.value)).map((weekday) => weekday.label).join(', ');
}
const operatingHours = computed(() => {
  const value = settings.data.value;
  if (!value) return '';
  if (value.operates_24_hours) return '24 hours';
  const overnight = value.operating_end_time <= value.operating_start_time;
  return `${clock(value.operating_start_time)} – ${clock(value.operating_end_time)}${overnight ? ' (next day)' : ''}`;
});
type PresetKey = 'warehouse_extended' | 'office_weekdays' | 'continuous_24h';
const SCHEDULE_PRESETS: { key: PresetKey; name: string; hours: string; description: string; patterns: string }[] = [
  { key: 'warehouse_extended', name: 'Warehouse extended', hours: '7:00 AM – 10:00 PM', description: 'Overlapping crews for receiving, inventory and dispatch.', patterns: 'Opening 7–3 · Mid 11–7 · Closing 2–10' },
  { key: 'office_weekdays', name: 'Office weekdays', hours: '8:00 AM – 5:00 PM', description: 'One regular weekday shift for administrative teams.', patterns: 'Day 8–5 · Monday–Friday' },
  { key: 'continuous_24h', name: 'Continuous 24/7', hours: 'Open 24 hours', description: 'Three eight-hour shifts with overnight coverage.', patterns: 'Day 6–2 · Evening 2–10 · Night 10–6' },
];

const busy = ref<string | null>(null);
const errors = ref<Record<string, string>>({});
async function run(key: string, fn: () => Promise<unknown>, done: string | null, after: () => Promise<unknown> = () => shifts.reload(true)) {
  busy.value = key;
  errors.value = {};
  try {
    await fn();
    if (done) toast.ok(done);
    await after();
    return true;
  } catch (err) {
    if (err instanceof ApiError) errors.value = err.fields;
    toast.error(errorMessage(err));
    return false;
  } finally {
    busy.value = null;
  }
}

// Shift types (templates)
type TypeForm = Omit<ShiftType, 'id' | 'overnight'> & { id: string | null };
const editing = ref<TypeForm | null>(null);
const newType = () =>
  (editing.value = { id: null, team_id: null, name: '', start_time: '08:00', end_time: '16:00', window_open_minutes: 30, grace_minutes: 30, allow_early_draft: true, is_active: true, weekdays: [1, 2, 3, 4, 5] });
async function saveType() {
  const { id, ...body } = editing.value!;
  const ok = await run('type', () => (id ? api.patch(`/manager/templates/${id}`, body) : api.post('/manager/templates', body)), 'Shift type saved', () => types.reload(true));
  if (ok) editing.value = null;
}
const overnight = computed(() => (editing.value ? editing.value.end_time <= editing.value.start_time : false));

const editingSettings = ref<Pick<ScheduleSettings, 'operating_start_time' | 'operating_end_time' | 'operates_24_hours'> | null>(null);
const selectedPreset = ref<PresetKey | null>(null);
function editOperatingHours() {
  const value = settings.data.value;
  if (!value) return;
  editingSettings.value = {
    operating_start_time: value.operating_start_time,
    operating_end_time: value.operating_end_time,
    operates_24_hours: value.operates_24_hours,
  };
}
async function saveOperatingHours() {
  const value = editingSettings.value!;
  const ok = await run(
    'settings',
    () => api.patch('/manager/schedule/settings', value),
    'Operating hours saved',
    () => settings.reload(true),
  );
  if (ok) editingSettings.value = null;
}
async function applyPreset() {
  const preset = selectedPreset.value;
  if (!preset) return;
  const ok = await run(
    'preset',
    () => api.post('/manager/schedule/preset', { preset }),
    'Schedule preset applied',
    () => Promise.all([settings.reload(true), types.reload(true)]),
  );
  if (ok) selectedPreset.value = null;
}

/** Creates the next 7 days of a shift type, skipping days that already have it. */
function addWeek(t: ShiftType) {
  let created = 0;
  return run(
    `gen-${t.id}`,
    async () => {
      created = (await api.post<{ created: number }>(`/manager/templates/${t.id}/generate`, { from: range.value.from, to: range.value.to, supervisor_id: me.value })).created;
    },
    null,
  ).then((ok) => ok && toast.ok(created ? `${created} ${t.name} shift${created === 1 ? '' : 's'} added to ${weekTitle.value}` : `${t.name} shifts already exist in this week`));
}

// One-off shift
const oneOff = ref<{ label: string; starts: string; ends: string } | null>(null);
async function createOneOff() {
  const o = oneOff.value!;
  const ok = await run('oneoff', () =>
    api.post('/manager/schedule', { label: o.label, starts_at: new Date(o.starts).toISOString(), ends_at: new Date(o.ends).toISOString(), supervisor_id: me.value }),
    'Shift added');
  if (ok) oneOff.value = null;
}

// Who is on duty
const unassign = (s: Shift, id: string) => run(`un-${s.id}-${id}`, () => api.del(`/manager/schedule/${s.id}/assignments/${id}`), 'Removed from shift');
const toggleCancel = (s: Shift) =>
  run(`cancel-${s.id}`, () => api.patch(`/manager/schedule/${s.id}`, { supervisor_id: s.supervisor_id, status: s.status === 'cancelled' ? 'scheduled' : 'cancelled' }), s.status === 'cancelled' ? 'Shift restored' : 'Shift cancelled');

const selectedShiftId = ref<string | null>(null);
const selectedEmployeeIds = ref<string[]>([]);
const selectedShift = computed(() => (shifts.data.value ?? []).find((shift) => shift.id === selectedShiftId.value) ?? null);
const availableWorkers = computed(() => {
  if (!selectedShift.value) return [];
  return workers.value.filter((worker) => !selectedShift.value!.assignees.some((assignee) => assignee.employee_id === worker.id));
});
function openShift(shift: Shift) {
  selectedShiftId.value = shift.id;
  selectedEmployeeIds.value = [];
}
async function assignSelected() {
  const shift = selectedShift.value;
  const ids = [...selectedEmployeeIds.value];
  if (!shift || !ids.length) return;
  let delivered = 0;
  const ok = await run(
    `assign-${shift.id}`,
    async () => {
      for (const employee_id of ids) {
        const result = await api.post<{ handovers_delivered: number }>(`/manager/schedule/${shift.id}/assignments`, { employee_id });
        delivered += result.handovers_delivered;
      }
    },
    null,
  );
  if (ok) {
    selectedEmployeeIds.value = [];
    toast.ok(`${ids.length} employee${ids.length === 1 ? '' : 's'} assigned`);
    if (delivered) toast.info(`${delivered} waiting handover${delivered === 1 ? '' : 's'} delivered`);
  }
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

const demo = () => run('demo', () => api.post('/manager/demo/timeline'), 'Demo shifts ready — Juan’s reporting window is open now');
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <PageHeader
      title="Schedule"
      description="Set the regular workday, create shift patterns, then assign everyone on duty."
    >
      <UiButton size="sm" variant="ghost" @click="oneOff = { label: '', starts: '', ends: '' }">One-off shift</UiButton>
      <UiButton v-if="auth.config?.demo" :loading="busy === 'demo'" @click="demo">Create demo shifts</UiButton>
    </PageHeader>

    <!-- The stable rules come first; the dated weekly schedule is generated from them. -->
    <section class="card mb-7 overflow-hidden" aria-labelledby="setup-heading">
      <div class="flex flex-col gap-4 border-b border-line px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="eyebrow">Regular schedule</p>
          <h2 id="setup-heading" class="mt-1 text-[18px] font-semibold">{{ settings.data.value?.department_name ?? 'Department' }} operating plan</h2>
          <p class="mt-1 text-[13px] text-ink-2">The operating day is the total time the department normally needs coverage.</p>
        </div>
        <div class="flex items-center gap-1.5">
          <UiButton size="sm" variant="ghost" @click="selectedPreset = 'warehouse_extended'">Use a preset</UiButton>
          <UiButton size="sm" variant="ghost" :disabled="!settings.data.value" @click="editOperatingHours">Edit operating hours</UiButton>
        </div>
      </div>

      <StateBlock :loading="settings.loading.value || types.loading.value" :error="settings.error.value || types.error.value" :empty="false" @retry="settings.reload(); types.reload()">
        <div class="grid border-b border-line lg:grid-cols-[0.8fr_2.2fr] lg:divide-x lg:divide-line">
          <div class="bg-canvas/60 px-5 py-5">
            <p class="text-[12px] font-medium text-ink-3">NORMAL OPERATING HOURS</p>
            <p class="mt-1.5 text-[20px] font-semibold tracking-[-0.015em] tnum">{{ operatingHours }}</p>
            <p v-if="settings.data.value && !settings.data.value.operates_24_hours" class="mt-1 text-[12.5px] text-ink-3">
              {{ durationLabel(settings.data.value.operating_start_time, settings.data.value.operating_end_time) }} of normal coverage
            </p>
            <p v-else class="mt-1 text-[12.5px] text-ink-3">Continuous coverage across midnight</p>
          </div>
          <div class="px-5 py-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="text-[14px] font-semibold">Shift patterns</h3>
                <p class="mt-0.5 text-[12.5px] text-ink-3">Reusable hours and working days. Fill the week, then assign one or many employees.</p>
              </div>
              <div class="flex items-center gap-1.5">
                <UiButton v-if="inactiveTypes.length" size="sm" variant="ghost" @click="showInactiveTypes = !showInactiveTypes">{{ showInactiveTypes ? 'Hide' : 'Show' }} {{ inactiveTypes.length }} inactive</UiButton>
                <UiButton size="sm" @click="newType">Add shift pattern</UiButton>
              </div>
            </div>

            <div v-if="activeTypes.length" class="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              <article v-for="t in activeTypes" :key="t.id" class="rounded-md border border-line bg-surface p-3.5">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-[13.5px] font-semibold">{{ t.name }}</p>
                    <p class="mt-0.5 text-[12.5px] text-ink-2 tnum">{{ clock(t.start_time) }} – {{ clock(t.end_time) }}<template v-if="t.overnight"> (+1 day)</template></p>
                  </div>
                  <span class="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[10.5px] font-medium text-ink-2">{{ durationLabel(t.start_time, t.end_time) }}</span>
                </div>
                <p class="mt-2 text-[11.5px] text-ink-3">{{ daysLabel(t.weekdays) }} · report opens {{ t.window_open_minutes }} min before end</p>
                <div class="mt-3 flex items-center gap-1.5">
                  <UiButton v-if="t.is_active" size="sm" :loading="busy === `gen-${t.id}`" @click="addWeek(t)">Fill this week</UiButton>
                  <UiButton size="sm" variant="ghost" @click="editing = { ...t }">Edit</UiButton>
                </div>
              </article>
            </div>
            <div v-else class="mt-4 rounded-md border border-dashed border-line px-4 py-5 text-center">
              <p class="text-[13px] font-medium">No shift patterns yet</p>
              <p class="mt-0.5 text-[12px] text-ink-3">Add the regular opening, middle or closing shifts used by your team.</p>
            </div>
            <div v-if="showInactiveTypes && inactiveTypes.length" class="mt-3 rounded-md border border-line bg-canvas/60 px-3.5 py-3">
              <p class="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">Inactive patterns</p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button v-for="t in inactiveTypes" :key="t.id" type="button" class="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2 hover:border-line-strong hover:text-ink" @click="editing = { ...t }">
                  {{ t.name }} · {{ clock(t.start_time) }}–{{ clock(t.end_time) }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="grid gap-px bg-line sm:grid-cols-3">
          <div class="bg-surface px-5 py-3.5"><p class="text-[12.5px] font-semibold">1 · Set the hours</p><p class="mt-0.5 text-[11.5px] text-ink-3">Define when the department normally operates.</p></div>
          <div class="bg-surface px-5 py-3.5"><p class="text-[12.5px] font-semibold">2 · Fill the week</p><p class="mt-0.5 text-[11.5px] text-ink-3">Generate only the selected days for each pattern.</p></div>
          <div class="bg-surface px-5 py-3.5"><p class="text-[12.5px] font-semibold">3 · Assign the crew</p><p class="mt-0.5 text-[11.5px] text-ink-3">A shift can have several employees working together.</p></div>
        </div>
      </StateBlock>
    </section>

    <!-- Calendar -->
    <section aria-labelledby="calendar-heading">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="calendar-heading" class="text-[16px] font-semibold">Weekly coverage</h2>
          <p class="mt-0.5 text-[13px] text-ink-3">{{ weekTitle }}</p>
        </div>
        <div class="flex items-center gap-1.5">
          <div class="mr-1 flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Schedule view">
            <button
              v-for="option in [{ value: 'calendar', label: 'Shifts' }, { value: 'people', label: 'People' }] as const"
              :key="option.value"
              type="button"
              class="rounded px-2.5 py-1 text-[12.5px]"
              :class="scheduleView === option.value ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'"
              @click="scheduleView = option.value"
            >{{ option.label }}</button>
          </div>
          <UiButton size="sm" variant="ghost" aria-label="Previous week" @click="moveWeek(-1)">←</UiButton>
          <UiButton size="sm" variant="ghost" @click="goToday">Today</UiButton>
          <UiButton size="sm" variant="ghost" aria-label="Next week" @click="moveWeek(1)">→</UiButton>
        </div>
      </div>

      <StateBlock :loading="shifts.loading.value" :error="shifts.error.value" :empty="false" @retry="shifts.reload()">
        <div v-if="scheduleView === 'calendar'" class="card overflow-hidden">
          <div class="grid md:grid-cols-7">
            <article
              v-for="(calendarDay, index) in calendarDays"
              :key="calendarDay.iso"
              class="min-h-36 border-b border-line p-3 last:border-b-0 md:min-h-[238px] md:border-b-0"
              :class="[
                index ? 'md:border-l' : '',
                calendarDay.isToday ? 'bg-accent-soft/30' : 'bg-surface',
              ]"
            >
              <header class="mb-3 flex items-center gap-2 md:block">
                <p class="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{{ calendarDay.label }}</p>
                <p
                  class="mt-1 grid size-7 place-items-center rounded-full text-[14px] font-semibold tnum"
                  :class="calendarDay.isToday ? 'bg-ink text-white' : 'text-ink'"
                >
                  {{ calendarDay.dateNumber }}
                </p>
              </header>

              <div class="space-y-2">
                <button
                  v-for="shift in calendarDay.shifts"
                  :key="shift.id"
                  type="button"
                  class="group w-full rounded-md border border-line bg-canvas px-3 py-2.5 text-left transition hover:border-line-strong hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  :class="{ 'opacity-55': shift.status === 'cancelled' }"
                  :aria-label="`Manage ${shift.label}, ${shift.assignees.length} assigned`"
                  @click="openShift(shift)"
                >
                  <span class="flex items-start justify-between gap-2">
                    <span class="min-w-0">
                      <span class="block truncate text-[13px] font-semibold">{{ shift.label }}</span>
                      <span class="mt-0.5 block text-[11.5px] text-ink-3 tnum">{{ shiftRange(shift) }}</span>
                    </span>
                    <span v-if="shift.status === 'cancelled'" class="mt-0.5 size-2 shrink-0 rounded-full bg-ink-3" title="Cancelled" />
                  </span>

                  <span class="mt-3 flex items-center justify-between gap-2">
                    <span v-if="shift.assignees.length" class="flex -space-x-1.5" :aria-label="`${shift.assignees.length} assigned`">
                      <span
                        v-for="assignee in shift.assignees.slice(0, 3)"
                        :key="assignee.employee_id"
                        class="grid size-6 place-items-center rounded-full border-2 border-canvas bg-surface text-[9px] font-semibold text-ink-2"
                        :title="assignee.full_name"
                      >
                        {{ initials(assignee.full_name) }}
                      </span>
                      <span v-if="shift.assignees.length > 3" class="grid size-6 place-items-center rounded-full border-2 border-canvas bg-surface text-[9px] font-semibold text-ink-2">+{{ shift.assignees.length - 3 }}</span>
                    </span>
                    <span v-else class="text-[11.5px] text-ink-3">Unassigned</span>
                    <span class="text-[16px] leading-none text-ink-3 group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden="true">›</span>
                  </span>
                </button>

                <p v-if="!calendarDay.shifts.length" class="rounded-md border border-dashed border-line px-3 py-5 text-center text-[12px] text-ink-3">No shifts</p>
              </div>
            </article>
          </div>
        </div>

        <div v-else class="card overflow-x-auto">
          <table class="min-w-[980px] w-full border-collapse text-left">
            <thead>
              <tr class="border-b border-line bg-canvas/60">
                <th class="sticky left-0 z-10 w-44 border-r border-line bg-canvas px-4 py-3 text-[12px] font-semibold text-ink-2">Employee</th>
                <th v-for="calendarDay in calendarDays" :key="calendarDay.iso" class="min-w-28 px-3 py-3 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                  {{ calendarDay.label }} <span class="ml-1 text-ink tnum">{{ calendarDay.dateNumber }}</span>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr v-for="worker in rosterRows" :key="worker.id" class="align-top hover:bg-canvas/50">
                <th class="sticky left-0 z-10 border-r border-line bg-surface px-4 py-3">
                  <span class="flex items-center gap-2.5">
                    <span class="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-[10px] font-semibold text-ink-2">{{ initials(worker.full_name) }}</span>
                    <span class="text-[13px] font-semibold">{{ worker.full_name }}</span>
                  </span>
                </th>
                <td v-for="(dayShifts, index) in worker.days" :key="calendarDays[index]!.iso" class="border-r border-line px-2 py-2 last:border-r-0">
                  <div v-if="dayShifts.length" class="space-y-1.5">
                    <button
                      v-for="shift in dayShifts"
                      :key="shift.id"
                      type="button"
                      class="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-left hover:border-line-strong hover:bg-sunken"
                      @click="openShift(shift)"
                    >
                      <span class="block truncate text-[12.5px] font-semibold">{{ shift.label }}</span>
                      <span class="block text-[11px] text-ink-3 tnum">{{ shiftRange(shift) }}</span>
                    </button>
                  </div>
                  <span v-else class="block py-2 text-center text-[11.5px] text-ink-3">Off</span>
                </td>
              </tr>
              <tr v-if="!rosterRows.length">
                <td colspan="8" class="px-5 py-8 text-center text-[13px] text-ink-3">No active employees in this department.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <UiDialog
      :open="Boolean(selectedShift)"
      :title="selectedShift?.label ?? 'Shift'"
      :description="selectedShift ? `${day(selectedShift.shift_date)} · ${shiftRange(selectedShift)}` : undefined"
      @close="selectedShiftId = null"
    >
      <div v-if="selectedShift" class="space-y-5">
        <div class="flex items-center justify-between gap-3 rounded-md border border-line bg-canvas px-4 py-3">
          <div>
            <p class="text-[12px] font-medium text-ink-3">Reporting window</p>
            <p class="mt-0.5 text-[14px] font-medium tnum">{{ time(selectedShift.window_opens_at, selectedShift.timezone) }} – {{ time(selectedShift.window_closes_at, selectedShift.timezone) }}</p>
          </div>
          <StatusBadge v-if="selectedShift.status === 'cancelled'" tone="neutral" label="Cancelled" />
          <StatusBadge v-else tone="ok" label="Scheduled" />
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[14px] font-semibold">Assigned employees</h3>
            <span class="text-[12px] text-ink-3">{{ selectedShift.assignees.length }} assigned</span>
          </div>
          <ul v-if="selectedShift.assignees.length" class="divide-y divide-line rounded-md border border-line">
            <li v-for="assignee in selectedShift.assignees" :key="assignee.employee_id" class="flex items-center justify-between gap-3 px-3 py-2.5">
              <span class="flex min-w-0 items-center gap-2.5">
                <span class="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-[10px] font-semibold text-ink-2">{{ initials(assignee.full_name) }}</span>
                <span class="truncate text-[13.5px] font-medium">{{ assignee.full_name }}</span>
              </span>
              <UiButton size="sm" variant="ghost" :loading="busy === `un-${selectedShift.id}-${assignee.employee_id}`" @click="unassign(selectedShift, assignee.employee_id)">Remove</UiButton>
            </li>
          </ul>
          <p v-else class="rounded-md border border-dashed border-line px-4 py-5 text-center text-[13px] text-ink-3">No employees assigned yet.</p>
        </div>

        <div v-if="selectedShift.status === 'scheduled' && availableWorkers.length">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h3 class="text-[14px] font-semibold">Add employees</h3>
            <span class="text-[12px] text-ink-3">Select everyone working this shift</span>
          </div>
          <div class="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
            <label v-for="worker in availableWorkers" :key="worker.id" class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] hover:bg-sunken">
              <input v-model="selectedEmployeeIds" type="checkbox" :value="worker.id" class="size-4 accent-accent" />
              <span class="grid size-7 shrink-0 place-items-center rounded-full bg-sunken text-[9px] font-semibold text-ink-2">{{ initials(worker.full_name) }}</span>
              <span class="truncate font-medium">{{ worker.full_name }}</span>
            </label>
          </div>
          <UiButton class="mt-3" variant="primary" :disabled="!selectedEmployeeIds.length" :loading="busy === `assign-${selectedShift.id}`" @click="assignSelected">
            Assign {{ selectedEmployeeIds.length || '' }} employee{{ selectedEmployeeIds.length === 1 ? '' : 's' }}
          </UiButton>
        </div>
        <p v-else-if="selectedShift.status === 'scheduled'" class="text-[13px] text-ink-3">All available employees are already assigned.</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" :loading="busy === `cancel-${selectedShift?.id}`" @click="selectedShift && toggleCancel(selectedShift)">
          {{ selectedShift?.status === 'cancelled' ? 'Restore shift' : 'Cancel shift' }}
        </UiButton>
        <UiButton variant="primary" @click="selectedShiftId = null">Done</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(selectedPreset)" title="Start from a schedule preset" description="Choose the closest operating model, then adjust any hours or working days." @close="selectedPreset = null">
      <div class="space-y-2">
        <label v-for="preset in SCHEDULE_PRESETS" :key="preset.key" class="block cursor-pointer rounded-md border p-4 transition" :class="selectedPreset === preset.key ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-canvas'">
          <span class="flex items-start gap-3">
            <input v-model="selectedPreset" type="radio" :value="preset.key" class="mt-1 size-4 accent-accent" />
            <span class="min-w-0">
              <span class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span class="text-[14px] font-semibold">{{ preset.name }}</span>
                <span class="text-[12px] font-medium text-ink-2 tnum">{{ preset.hours }}</span>
              </span>
              <span class="mt-1 block text-[12.5px] text-ink-2">{{ preset.description }}</span>
              <span class="mt-1 block text-[11.5px] text-ink-3 tnum">{{ preset.patterns }}</span>
            </span>
          </span>
        </label>
        <p class="pt-1 text-[12px] text-ink-3">This updates the reusable operating rules. Existing dated shifts, assignments and reports are preserved.</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="selectedPreset = null">Cancel</UiButton>
        <UiButton variant="primary" :loading="busy === 'preset'" @click="applyPreset">Apply preset</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(editingSettings)" title="Operating hours" description="The normal coverage period for this department. Shift patterns may overlap inside it." @close="editingSettings = null">
      <form v-if="editingSettings" id="settings-form" class="space-y-4" @submit.prevent="saveOperatingHours">
        <label class="flex items-start gap-3 rounded-md border border-line bg-canvas px-4 py-3">
          <input v-model="editingSettings.operates_24_hours" type="checkbox" class="mt-0.5 size-4 accent-accent" />
          <span><span class="block text-[14px] font-medium">Open 24 hours</span><span class="mt-0.5 block text-[12.5px] text-ink-3">Use this for continuous operations with overnight shifts.</span></span>
        </label>
        <div class="grid grid-cols-2 gap-3" :class="{ 'opacity-45': editingSettings.operates_24_hours }">
          <UiField v-slot="{ id }" label="Opens"><input :id="id" v-model="editingSettings.operating_start_time" type="time" class="field-input" :disabled="editingSettings.operates_24_hours" /></UiField>
          <UiField v-slot="{ id }" label="Closes"><input :id="id" v-model="editingSettings.operating_end_time" type="time" class="field-input" :disabled="editingSettings.operates_24_hours" /></UiField>
        </div>
        <p v-if="!editingSettings.operates_24_hours" class="text-[13px] text-ink-2 tnum">
          Normal day: {{ clock(editingSettings.operating_start_time) }} – {{ clock(editingSettings.operating_end_time) }} · {{ durationLabel(editingSettings.operating_start_time, editingSettings.operating_end_time) }}
        </p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="editingSettings = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="settings-form" :loading="busy === 'settings'">Save hours</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit shift pattern' : 'Add shift pattern'" description="A reusable time block. You can assign several employees to every generated shift." @close="editing = null">
      <form v-if="editing" id="type-form" class="space-y-4" @submit.prevent="saveType">
        <UiField v-slot="{ id }" label="Pattern name" :error="errors.name"><input :id="id" v-model="editing.name" class="field-input" maxlength="80" placeholder="Opening shift" /></UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Starts" :error="errors.start_time"><input :id="id" v-model="editing.start_time" type="time" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Ends" :error="errors.end_time"><input :id="id" v-model="editing.end_time" type="time" class="field-input" /></UiField>
        </div>
        <p class="-mt-2 text-[12.5px]" :class="overnight ? 'text-info' : 'text-ink-3'">{{ durationLabel(editing.start_time, editing.end_time) }}<template v-if="overnight"> · ends the next day</template></p>
        <UiField label="Working days" hint="Only these days are created when you fill a week">
          <div class="grid grid-cols-7 gap-1.5">
            <label v-for="weekday in WEEKDAYS" :key="weekday.value" class="cursor-pointer">
              <input v-model="editing.weekdays" type="checkbox" :value="weekday.value" class="peer sr-only" />
              <span class="grid h-9 place-items-center rounded-md border border-line text-[11.5px] font-medium text-ink-2 peer-checked:border-accent peer-checked:bg-accent peer-checked:text-white">{{ weekday.label }}</span>
            </label>
          </div>
        </UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Reporting opens" hint="Minutes before the shift ends">
            <input :id="id" v-model.number="editing.window_open_minutes" type="number" min="5" max="240" class="field-input" />
          </UiField>
          <UiField v-slot="{ id }" label="Grace period" hint="Minutes after the shift ends">
            <input :id="id" v-model.number="editing.grace_minutes" type="number" min="0" max="240" class="field-input" />
          </UiField>
        </div>
        <p class="text-[13px] text-ink-2 tnum">Workers can submit from {{ minus(editing.end_time, editing.window_open_minutes) }} to {{ minus(editing.end_time, -editing.grace_minutes) }}.</p>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="editing.allow_early_draft" type="checkbox" class="size-4 accent-accent" /> Workers can start a draft earlier</label>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="editing.is_active" type="checkbox" class="size-4 accent-accent" /> In use</label>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="type-form" :loading="busy === 'type'" :disabled="!editing?.weekdays.length">Save pattern</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(oneOff)" title="One-off shift" description="For cover or overtime outside the regular shift types." @close="oneOff = null">
      <form v-if="oneOff" id="oneoff-form" class="space-y-4" @submit.prevent="createOneOff">
        <UiField v-slot="{ id }" label="Name" :error="errors.label"><input :id="id" v-model="oneOff.label" class="field-input" maxlength="80" placeholder="Overtime — inventory count" /></UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Starts" :error="errors.starts_at"><input :id="id" v-model="oneOff.starts" type="datetime-local" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Ends" :error="errors.ends_at"><input :id="id" v-model="oneOff.ends" type="datetime-local" class="field-input" /></UiField>
        </div>
        <p class="text-[12.5px] text-ink-3">Reporting opens 30 minutes before the end, with 30 minutes’ grace.</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="oneOff = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="oneoff-form" :loading="busy === 'oneoff'" :disabled="!oneOff?.starts || !oneOff?.ends || (oneOff?.label.trim().length ?? 0) < 2">Add shift</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
