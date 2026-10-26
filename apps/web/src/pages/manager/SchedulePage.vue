<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { day, shiftRange } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * The supervisor's schedule: the department's regular shifts (Morning 6–2 and Afternoon 2–10
 * for the warehouse) as rows, the days of the week as columns. Every day already has its
 * shifts; the supervisor only picks who works each one.
 */
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
interface Shift {
  id: string;
  label: string;
  shift_date: string;
  timezone: string;
  status: 'scheduled' | 'cancelled';
  starts_at: string;
  ends_at: string;
  supervisor_id: string | null;
  template_id: string | null;
  assignees: { employee_id: string; full_name: string }[];
}

const auth = useAuth();
const toast = useToast();
const me = computed(() => auth.profile?.id ?? null);

const localIso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
const range = computed(() => ({ from: localIso(weekStart.value), to: localIso(addDays(weekStart.value, 6)) }));
const weekTitle = computed(() => {
  const end = addDays(weekStart.value, 6);
  const startText = weekStart.value.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  const endText = end.toLocaleDateString('en-PH', { month: weekStart.value.getMonth() === end.getMonth() ? undefined : 'short', day: 'numeric', year: 'numeric' });
  return `${startText} – ${endText}`;
});
const moveWeek = (amount: number) => (weekStart.value = addDays(weekStart.value, amount * 7));
const goToday = () => (weekStart.value = startOfWeek(new Date()));

const types = useAsync(() => api.get<ShiftType[]>('/manager/templates'));
const shifts = useAsync(() => api.get<Shift[]>(`/manager/schedule?from=${range.value.from}&to=${range.value.to}`), [weekStart]);
const staff = useAsync(() => api.get<{ id: string; full_name: string; role: string }[]>('/department/staff'));
const workers = computed(() => (staff.data.value ?? []).filter((p) => p.role === 'employee'));
const patterns = computed(() => (types.data.value ?? []).filter((t) => t.is_active).sort((a, b) => a.start_time.localeCompare(b.start_time)));

const days = computed(() => {
  const label = new Intl.DateTimeFormat('en-PH', { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart.value, i);
    const iso = localIso(date);
    return { iso, label: label.format(date), dateNumber: date.getDate(), isToday: iso === todayIso, isPast: iso < todayIso, isoDow: ((date.getDay() + 6) % 7) + 1 };
  });
});
const cell = (patternId: string, iso: string) =>
  (shifts.data.value ?? []).find((s) => s.template_id === patternId && s.shift_date === iso && s.status === 'scheduled') ??
  (shifts.data.value ?? []).find((s) => s.template_id === patternId && s.shift_date === iso) ??
  null;
/** Overtime or older-pattern shifts that are not one of the regular rows. */
const otherShifts = computed(() => {
  const ids = new Set(patterns.value.map((p) => p.id));
  return (shifts.data.value ?? []).filter((s) => s.status === 'scheduled' && (!s.template_id || !ids.has(s.template_id)));
});

/** "14:00" → "2:00 PM" */
function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

const busy = ref<string | null>(null);
async function run(key: string, fn: () => Promise<unknown>, done: string | null) {
  busy.value = key;
  try {
    await fn();
    if (done) toast.ok(done);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  } finally {
    busy.value = null;
    await shifts.reload(true);
  }
}

// Every day of the visible week has its regular shifts, so the supervisor never "fills" a week.
const filled = new Set<string>();
watch(
  () => [shifts.data.value, patterns.value] as const,
  async ([list, active]) => {
    if (!list || !active.length) return;
    const from = range.value.from < todayIso ? todayIso : range.value.from;
    if (from > range.value.to) return;
    const missing = active.filter((p) =>
      days.value.some((d) => d.iso >= from && p.weekdays.includes(d.isoDow) && !list.some((s) => s.template_id === p.id && s.shift_date === d.iso)),
    );
    const todo = missing.filter((p) => !filled.has(`${range.value.from}:${p.id}`));
    if (!todo.length) return;
    for (const p of todo) filled.add(`${range.value.from}:${p.id}`);
    try {
      for (const p of todo) await api.post(`/manager/templates/${p.id}/generate`, { from, to: range.value.to, supervisor_id: me.value });
      await shifts.reload(true);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  },
);

// Picking the crew for one shift
const selectedShiftId = ref<string | null>(null);
const selectedEmployeeIds = ref<string[]>([]);
const selectedShift = computed(() => (shifts.data.value ?? []).find((s) => s.id === selectedShiftId.value) ?? null);
const availableWorkers = computed(() =>
  selectedShift.value ? workers.value.filter((w) => !selectedShift.value!.assignees.some((a) => a.employee_id === w.id)) : [],
);
function openShift(s: Shift) {
  selectedShiftId.value = s.id;
  selectedEmployeeIds.value = [];
}
async function assignSelected() {
  const s = selectedShift.value;
  const ids = [...selectedEmployeeIds.value];
  if (!s || !ids.length) return;
  let delivered = 0;
  const ok = await run(
    `assign-${s.id}`,
    async () => {
      for (const employee_id of ids) delivered += (await api.post<{ handovers_delivered: number }>(`/manager/schedule/${s.id}/assignments`, { employee_id })).handovers_delivered;
    },
    null,
  );
  if (ok) {
    selectedEmployeeIds.value = [];
    toast.ok(`${ids.length} added to ${s.label}`);
    if (delivered) toast.info(`${delivered} waiting handover${delivered === 1 ? '' : 's'} delivered`);
  }
}
const unassign = (s: Shift, id: string) => run(`un-${s.id}-${id}`, () => api.del(`/manager/schedule/${s.id}/assignments/${id}`), 'Removed from shift');
const toggleCancel = (s: Shift) =>
  run(`cancel-${s.id}`, () => api.patch(`/manager/schedule/${s.id}`, { supervisor_id: s.supervisor_id, status: s.status === 'cancelled' ? 'scheduled' : 'cancelled' }), s.status === 'cancelled' ? 'Shift restored' : 'Day off for this shift — cancelled');

/** Same people on the same shifts as the week before, from today onwards. */
async function copyLastWeek() {
  let copied = 0;
  let skipped = 0;
  await run(
    'copy',
    async () => {
      const prevFrom = localIso(addDays(weekStart.value, -7));
      const prevTo = localIso(addDays(weekStart.value, -1));
      const previous = await api.get<Shift[]>(`/manager/schedule?from=${prevFrom}&to=${prevTo}`);
      for (const s of shifts.data.value ?? []) {
        if (!s.template_id || s.status !== 'scheduled' || s.shift_date < todayIso) continue;
        const lastWeek = localIso(addDays(new Date(`${s.shift_date}T12:00:00`), -7));
        const before = previous.find((p) => p.template_id === s.template_id && p.shift_date === lastWeek);
        for (const a of before?.assignees ?? []) {
          if (s.assignees.some((x) => x.employee_id === a.employee_id)) continue;
          try {
            await api.post(`/manager/schedule/${s.id}/assignments`, { employee_id: a.employee_id });
            copied++;
          } catch {
            skipped++;
          }
        }
      }
    },
    null,
  );
  if (copied || skipped) toast.ok(`Copied ${copied} from last week${skipped ? ` · ${skipped} skipped (already on another shift)` : ''}`);
  else toast.info('Nothing to copy — last week had no crew on these days');
}

// Setting up the department's shifts: each supervisor's own pattern, any number of shifts.
type DaysChoice = 'all' | 'weekdays' | 'mon_sat';
const DAYS: Record<DaysChoice, { label: string; days: number[] }> = {
  all: { label: 'Every day', days: [1, 2, 3, 4, 5, 6, 7] },
  weekdays: { label: 'Mon – Fri', days: [1, 2, 3, 4, 5] },
  mon_sat: { label: 'Mon – Sat', days: [1, 2, 3, 4, 5, 6] },
};
const choiceFor = (days: number[]): DaysChoice =>
  (Object.keys(DAYS) as DaysChoice[]).find((k) => DAYS[k].days.join() === [...days].sort((a, b) => a - b).join()) ?? 'all';
interface SetupRow {
  id: string | null;
  name: string;
  start_time: string;
  end_time: string;
  days: DaysChoice;
}
const editingShifts = ref<SetupRow[] | null>(null);
const addHours = (hhmm: string, hours: number) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${String((h + hours) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
function openShiftSetup() {
  editingShifts.value = patterns.value.length
    ? patterns.value.map((p) => ({ id: p.id, name: p.name, start_time: p.start_time, end_time: p.end_time, days: choiceFor(p.weekdays) }))
    : [
        { id: null, name: 'Morning', start_time: '06:00', end_time: '14:00', days: 'all' },
        { id: null, name: 'Afternoon', start_time: '14:00', end_time: '22:00', days: 'all' },
      ];
}
function addRow() {
  const last = editingShifts.value!.at(-1);
  const start = last?.end_time ?? '08:00';
  editingShifts.value!.push({ id: null, name: '', start_time: start, end_time: addHours(start, 8), days: last?.days ?? 'all' });
}
const setupValid = computed(
  () =>
    !!editingShifts.value?.length &&
    editingShifts.value.every((r) => r.name.trim().length >= 2 && r.start_time && r.end_time && r.start_time !== r.end_time) &&
    new Set(editingShifts.value.map((r) => r.name.trim().toLowerCase())).size === editingShifts.value.length,
);
const templateBody = (r: Pick<SetupRow, 'name' | 'start_time' | 'end_time'> & { weekdays: number[] }, base: ShiftType | undefined, active: boolean) => ({
  team_id: base?.team_id ?? null,
  name: r.name.trim(),
  start_time: r.start_time,
  end_time: r.end_time,
  window_open_minutes: base?.window_open_minutes ?? 30,
  grace_minutes: base?.grace_minutes ?? 30,
  allow_early_draft: base?.allow_early_draft ?? true,
  is_active: active,
  weekdays: r.weekdays,
});
async function saveShiftSetup() {
  const rows = editingShifts.value!;
  const all = types.data.value ?? [];
  let cancelled = 0;
  const ok = await run(
    'setup',
    async () => {
      // Shifts taken off the list go first, so their old shifts leave the schedule.
      for (const p of patterns.value.filter((p) => !rows.some((r) => r.id === p.id))) {
        cancelled += (await api.patch<{ cancelled: number }>(`/manager/templates/${p.id}`, templateBody(p, p, false))).cancelled;
      }
      for (const r of rows) {
        // A name used before comes back as the same pattern rather than a duplicate.
        const existing = r.id ? all.find((p) => p.id === r.id) : all.find((p) => !p.is_active && p.name.toLowerCase() === r.name.trim().toLowerCase());
        const payload = templateBody({ ...r, weekdays: DAYS[r.days].days }, existing, true);
        if (existing) await api.patch(`/manager/templates/${existing.id}`, payload);
        else await api.post('/manager/templates', payload);
      }
      await types.reload(true);
    },
    'Shifts saved — the schedule now follows them',
  );
  if (ok) {
    editingShifts.value = null;
    if (cancelled) toast.info(`${cancelled} shift${cancelled === 1 ? '' : 's'} from removed patterns taken off the schedule`);
  }
}

</script>

<template>
  <div class="mx-auto max-w-6xl">
    <PageHeader title="Schedule" description="Your department’s shifts for the week. Tap a shift to choose who works it.">
      <UiButton size="sm" variant="ghost" :disabled="types.loading.value" @click="openShiftSetup">Edit shifts</UiButton>
    </PageHeader>

    <!-- The day at a glance: who hands over to whom, and when -->
    <StateBlock :loading="types.loading.value" :error="types.error.value" :empty="false" @retry="types.reload()">
      <section v-if="!patterns.length" class="card mb-6 flex flex-col items-start gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-[15px] font-semibold">Set up your department’s shifts</p>
          <p class="text-[13px] text-ink-3">For example Morning 6 AM – 2 PM and Afternoon 2 PM – 10 PM. Each department sets its own.</p>
        </div>
        <UiButton variant="primary" @click="openShiftSetup">Set up shifts</UiButton>
      </section>
      <section v-else class="card mb-6 flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center" aria-label="Daily shifts">
        <template v-for="(p, i) in patterns" :key="p.id">
          <div class="flex items-center gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-full text-[12px] font-semibold" :class="i % 2 ? 'bg-info-soft text-info' : 'bg-warn-soft text-warn'">{{ i + 1 }}</span>
            <div>
              <p class="text-[15px] font-semibold">{{ p.name }}</p>
              <p class="text-[13px] text-ink-2 tnum">{{ clock(p.start_time) }} – {{ clock(p.end_time) }}</p>
            </div>
          </div>
          <p class="flex items-center gap-2 text-[12.5px] text-ink-3 md:flex-1 md:justify-center">
            <span aria-hidden="true">→</span>
            hands over at {{ clock(p.end_time) }}{{ i === patterns.length - 1 ? ` to the next ${patterns[0]!.name}` : '' }}
          </p>
        </template>
      </section>
    </StateBlock>

    <!-- The week -->
    <section aria-labelledby="week-heading">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="week-heading" class="text-[16px] font-semibold">{{ weekTitle }}</h2>
          <p class="mt-0.5 text-[13px] text-ink-3">Each shift can have several people.</p>
        </div>
        <div class="flex items-center gap-1.5">
          <UiButton size="sm" variant="ghost" :loading="busy === 'copy'" @click="copyLastWeek">Copy last week’s crew</UiButton>
          <UiButton size="sm" variant="ghost" aria-label="Previous week" @click="moveWeek(-1)">←</UiButton>
          <UiButton size="sm" variant="ghost" @click="goToday">This week</UiButton>
          <UiButton size="sm" variant="ghost" aria-label="Next week" @click="moveWeek(1)">→</UiButton>
        </div>
      </div>

      <StateBlock :loading="shifts.loading.value" :refreshing="shifts.refreshing.value" :error="shifts.error.value" :empty="false" @retry="shifts.reload()">
        <div class="card overflow-x-auto">
          <table class="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr class="border-b border-line">
                <th class="sticky left-0 z-10 w-40 border-r border-line bg-surface px-4 py-3 text-[12px] font-semibold text-ink-3">Shift</th>
                <th v-for="d in days" :key="d.iso" class="px-2 py-2.5 text-center" :class="{ 'bg-accent-soft/40': d.isToday }">
                  <span class="block text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{{ d.label }}</span>
                  <span class="mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-[14px] font-semibold tnum" :class="d.isToday ? 'bg-ink text-white' : 'text-ink'">{{ d.dateNumber }}</span>
                </th>
              </tr>
            </thead>
            <tbody class="stagger divide-y divide-line">
              <tr v-for="p in patterns" :key="p.id" class="align-top">
                <th class="sticky left-0 z-10 border-r border-line bg-surface px-4 py-3">
                  <span class="block text-[14px] font-semibold">{{ p.name }}</span>
                  <span class="block text-[12px] font-normal text-ink-3 tnum">{{ clock(p.start_time) }} – {{ clock(p.end_time) }}</span>
                </th>
                <td v-for="d in days" :key="d.iso" class="p-1.5" :class="{ 'bg-accent-soft/40': d.isToday, 'opacity-60': d.isPast }">
                  <button
                    v-if="cell(p.id, d.iso)"
                    type="button"
                    class="lift flex min-h-20 w-full flex-col gap-1 rounded-md border px-2 py-2 text-left hover:border-line-strong hover:bg-sunken"
                    :class="cell(p.id, d.iso)!.status === 'cancelled' ? 'border-dashed border-line bg-canvas' : cell(p.id, d.iso)!.assignees.length ? 'border-line bg-surface' : 'border-warn/40 bg-warn-soft/40'"
                    :aria-label="`${p.name}, ${d.label} ${d.dateNumber}: ${cell(p.id, d.iso)!.assignees.length} assigned`"
                    @click="openShift(cell(p.id, d.iso)!)"
                  >
                    <template v-if="cell(p.id, d.iso)!.status === 'cancelled'">
                      <span class="text-[12px] text-ink-3">Cancelled</span>
                    </template>
                    <template v-else-if="cell(p.id, d.iso)!.assignees.length">
                      <span v-for="a in cell(p.id, d.iso)!.assignees.slice(0, 3)" :key="a.employee_id" class="truncate rounded bg-sunken px-1.5 py-0.5 text-[12px] font-medium">{{ firstName(a.full_name) }}</span>
                      <span v-if="cell(p.id, d.iso)!.assignees.length > 3" class="text-[11.5px] text-ink-3">+{{ cell(p.id, d.iso)!.assignees.length - 3 }} more</span>
                    </template>
                    <span v-else class="text-[12px] font-medium text-warn">{{ d.isPast ? 'No one' : '+ Add people' }}</span>
                  </button>
                  <span v-else class="grid min-h-20 place-items-center text-[11.5px] text-ink-3">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="otherShifts.length" class="mt-4">
          <h3 class="text-[13px] font-semibold text-ink-2">Other shifts this week</h3>
          <p class="text-[12px] text-ink-3">Overtime or older shifts outside the regular {{ patterns.map((p) => p.name).join(' / ') }} pattern.</p>
          <div class="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <button
              v-for="s in otherShifts"
              :key="s.id"
              type="button"
              class="lift rounded-md border border-line bg-surface px-3 py-2.5 text-left hover:border-line-strong hover:bg-sunken"
              :class="{ 'opacity-55': s.status === 'cancelled' }"
              @click="openShift(s)"
            >
              <span class="block truncate text-[13px] font-semibold">{{ s.label }}</span>
              <span class="block text-[12px] text-ink-3 tnum">{{ day(s.shift_date) }} · {{ shiftRange(s) }}{{ s.status === 'cancelled' ? ' · cancelled' : '' }}</span>
              <span class="mt-1 block truncate text-[12px] text-ink-2">{{ s.assignees.length ? s.assignees.map((a) => firstName(a.full_name)).join(', ') : 'No one assigned' }}</span>
            </button>
          </div>
        </div>
      </StateBlock>
    </section>

    <UiDialog
      :open="Boolean(selectedShift)"
      :title="selectedShift ? `${selectedShift.label} · ${day(selectedShift.shift_date)}` : 'Shift'"
      :description="selectedShift ? shiftRange(selectedShift) : undefined"
      @close="selectedShiftId = null"
    >
      <div v-if="selectedShift" class="space-y-5">
        <div>
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[14px] font-semibold">Working this shift</h3>
            <span class="text-[12px] text-ink-3">{{ selectedShift.assignees.length }} {{ selectedShift.assignees.length === 1 ? 'person' : 'people' }}</span>
          </div>
          <ul v-if="selectedShift.assignees.length" class="divide-y divide-line rounded-md border border-line">
            <li v-for="a in selectedShift.assignees" :key="a.employee_id" class="flex items-center justify-between gap-3 px-3 py-2.5">
              <span class="flex min-w-0 items-center gap-2.5">
                <span class="grid size-8 shrink-0 place-items-center rounded-full bg-sunken text-[10px] font-semibold text-ink-2">{{ initials(a.full_name) }}</span>
                <span class="truncate text-[13.5px] font-medium">{{ a.full_name }}</span>
              </span>
              <UiButton size="sm" variant="ghost" :loading="busy === `un-${selectedShift.id}-${a.employee_id}`" @click="unassign(selectedShift, a.employee_id)">Remove</UiButton>
            </li>
          </ul>
          <p v-else class="rounded-md border border-dashed border-line px-4 py-5 text-center text-[13px] text-ink-3">No one yet.</p>
        </div>

        <div v-if="selectedShift.status === 'scheduled' && availableWorkers.length">
          <h3 class="mb-2 text-[14px] font-semibold">Add people</h3>
          <div class="grid max-h-56 gap-1 overflow-y-auto rounded-md border border-line p-2 sm:grid-cols-2">
            <label v-for="w in availableWorkers" :key="w.id" class="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] hover:bg-sunken">
              <input v-model="selectedEmployeeIds" type="checkbox" :value="w.id" class="size-4 accent-accent" />
              <span class="truncate font-medium">{{ w.full_name }}</span>
            </label>
          </div>
          <UiButton class="mt-3" variant="primary" :disabled="!selectedEmployeeIds.length" :loading="busy === `assign-${selectedShift.id}`" @click="assignSelected">
            Add {{ selectedEmployeeIds.length || '' }} {{ selectedEmployeeIds.length === 1 ? 'person' : 'people' }}
          </UiButton>
          <p class="mt-2 text-[12px] text-ink-3">Someone already on another shift at the same time can’t be added.</p>
        </div>
        <p v-else-if="selectedShift.status === 'scheduled'" class="text-[13px] text-ink-3">Everyone is already on this shift.</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" :loading="busy === `cancel-${selectedShift?.id}`" @click="selectedShift && toggleCancel(selectedShift)">
          {{ selectedShift?.status === 'cancelled' ? 'Restore shift' : 'Cancel this shift' }}
        </UiButton>
        <UiButton variant="primary" @click="selectedShiftId = null">Done</UiButton>
      </template>
    </UiDialog>

    <UiDialog
      :open="Boolean(editingShifts)"
      title="Your department’s shifts"
      description="The shifts your team works. The schedule follows them: a removed shift leaves the schedule, new times move upcoming shifts."
      @close="editingShifts = null"
    >
      <form v-if="editingShifts" id="setup-form" class="space-y-3" @submit.prevent="saveShiftSetup">
        <div v-for="(r, i) in editingShifts" :key="r.id ?? `new-${i}`" class="rounded-md border border-line p-3">
          <div class="flex items-end gap-2">
            <UiField v-slot="{ id }" label="Name" class="flex-1"><input :id="id" v-model="r.name" class="field-input" maxlength="80" placeholder="e.g. Morning" /></UiField>
            <UiButton size="sm" variant="ghost" :aria-label="`Remove ${r.name || 'this shift'}`" :disabled="editingShifts.length === 1" @click="editingShifts.splice(i, 1)">Remove</UiButton>
          </div>
          <div class="mt-2 grid grid-cols-3 gap-2">
            <UiField v-slot="{ id }" label="Starts"><input :id="id" v-model="r.start_time" type="time" class="field-input" /></UiField>
            <UiField v-slot="{ id }" label="Ends"><input :id="id" v-model="r.end_time" type="time" class="field-input" /></UiField>
            <UiField v-slot="{ id }" label="Days">
              <select :id="id" v-model="r.days" class="field-input">
                <option v-for="(d, k) in DAYS" :key="k" :value="k">{{ d.label }}</option>
              </select>
            </UiField>
          </div>
          <p v-if="r.end_time < r.start_time" class="mt-1.5 text-[12px] text-info">Ends the next day</p>
        </div>
        <UiButton size="sm" @click="addRow">+ Add a shift</UiButton>
        <p v-if="!setupValid" class="text-[12.5px] text-warn">Give every shift its own name and a start and end time.</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="editingShifts = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="setup-form" :loading="busy === 'setup'" :disabled="!setupValid">Save shifts</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
