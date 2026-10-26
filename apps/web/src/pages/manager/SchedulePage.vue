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

const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const week = ref<'this' | 'next'>('this');
const range = computed(() => (week.value === 'this' ? { from: isoDay(-1), to: isoDay(6) } : { from: isoDay(7), to: isoDay(13) }));

const types = useAsync(() => api.get<ShiftType[]>('/manager/templates'));
const shifts = useAsync(() => api.get<Shift[]>(`/manager/schedule?from=${range.value.from}&to=${range.value.to}`), [week]);
const staff = useAsync(() => api.get<{ id: string; full_name: string; role: string }[]>('/department/staff'));
const workers = computed(() => (staff.data.value ?? []).filter((p) => p.role === 'employee'));
const byDate = computed(() => {
  const groups = new Map<string, Shift[]>();
  for (const s of shifts.data.value ?? []) groups.set(s.shift_date, [...(groups.get(s.shift_date) ?? []), s]);
  return [...groups];
});

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
  (editing.value = { id: null, team_id: null, name: '', start_time: '06:00', end_time: '14:00', window_open_minutes: 30, grace_minutes: 30, allow_early_draft: true, is_active: true });
async function saveType() {
  const { id, ...body } = editing.value!;
  const ok = await run('type', () => (id ? api.patch(`/manager/templates/${id}`, body) : api.post('/manager/templates', body)), 'Shift type saved', () => types.reload(true));
  if (ok) editing.value = null;
}
const overnight = computed(() => (editing.value ? editing.value.end_time <= editing.value.start_time : false));

/** Creates the next 7 days of a shift type, skipping days that already have it. */
function addWeek(t: ShiftType) {
  let created = 0;
  return run(
    `gen-${t.id}`,
    async () => {
      created = (await api.post<{ created: number }>(`/manager/templates/${t.id}/generate`, { from: isoDay(0), to: isoDay(6), supervisor_id: me.value })).created;
    },
    null,
  ).then((ok) => ok && toast.ok(created ? `${created} ${t.name} shift${created === 1 ? '' : 's'} added for the next 7 days` : `${t.name} shifts already exist for the next 7 days`));
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
const pick = ref<Record<string, string>>({});
function assign(s: Shift) {
  const employee_id = pick.value[s.id];
  if (!employee_id) return;
  void run(`assign-${s.id}`, async () => {
    const r = await api.post<{ handovers_delivered: number }>(`/manager/schedule/${s.id}/assignments`, { employee_id });
    if (r.handovers_delivered) toast.info('A waiting handover was delivered to them');
    pick.value[s.id] = '';
  }, 'Added to shift');
}
const unassign = (s: Shift, id: string) => run(`un-${s.id}-${id}`, () => api.del(`/manager/schedule/${s.id}/assignments/${id}`), 'Removed from shift');
const toggleCancel = (s: Shift) =>
  run(`cancel-${s.id}`, () => api.patch(`/manager/schedule/${s.id}`, { supervisor_id: s.supervisor_id, status: s.status === 'cancelled' ? 'scheduled' : 'cancelled' }), s.status === 'cancelled' ? 'Shift restored' : 'Shift cancelled');

const demo = () => run('demo', () => api.post('/manager/demo/timeline'), 'Demo shifts ready — Juan’s reporting window is open now');
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <PageHeader
      title="Schedule"
      description="Your shifts and who is on duty. Each worker reports at the end of their shift; once you approve it, the next shift receives the handover automatically."
    >
      <UiButton v-if="auth.config?.demo" :loading="busy === 'demo'" @click="demo">Create demo shifts</UiButton>
    </PageHeader>

    <!-- Shift types -->
    <section class="mb-8">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="text-[15px] font-semibold">Shift types</h2>
        <UiButton size="sm" @click="newType">Add shift type</UiButton>
      </div>
      <StateBlock :loading="types.loading.value" :error="types.error.value" :empty="!types.data.value?.length" empty-title="No shift types yet" empty-text="Add one, e.g. Morning 6:00 AM – 2:00 PM." @retry="types.reload()">
        <ul class="card divide-y divide-line">
          <li v-for="t in types.data.value" :key="t.id" class="flex flex-wrap items-center justify-between gap-3 px-5 py-3" :class="{ 'opacity-60': !t.is_active }">
            <div>
              <p class="text-[14px] font-medium">
                {{ t.name }} <span class="font-normal text-ink-2 tnum">{{ clock(t.start_time) }} – {{ clock(t.end_time) }}<template v-if="t.overnight"> (next day)</template></span>
              </p>
              <p class="text-[13px] text-ink-3 tnum">Reporting {{ minus(t.end_time, t.window_open_minutes) }} – {{ minus(t.end_time, -t.grace_minutes) }}</p>
            </div>
            <div class="flex gap-1">
              <UiButton v-if="t.is_active" size="sm" :loading="busy === `gen-${t.id}`" @click="addWeek(t)">Add next 7 days</UiButton>
              <UiButton size="sm" variant="ghost" @click="editing = { ...t }">Edit</UiButton>
            </div>
          </li>
        </ul>
      </StateBlock>
    </section>

    <!-- Who is on duty -->
    <section>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-[15px] font-semibold">Who’s on duty</h2>
        <div class="flex items-center gap-2">
          <div class="flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Week">
            <button
              v-for="w in [{ k: 'this', l: 'This week' }, { k: 'next', l: 'Next week' }] as const"
              :key="w.k"
              class="rounded px-3 py-1 text-[13px]"
              :class="week === w.k ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'"
              @click="week = w.k"
            >
              {{ w.l }}
            </button>
          </div>
          <UiButton size="sm" variant="ghost" @click="oneOff = { label: '', starts: '', ends: '' }">One-off shift</UiButton>
        </div>
      </div>
      <StateBlock
        :loading="shifts.loading.value"
        :error="shifts.error.value"
        :empty="!byDate.length"
        empty-title="No shifts this week"
        empty-text="Use “Add next 7 days” on a shift type."
        @retry="shifts.reload()"
      >
        <div class="space-y-5">
          <div v-for="[date, list] in byDate" :key="date">
            <p class="eyebrow mb-1.5">{{ day(date) }}</p>
            <ul class="card divide-y divide-line">
              <li v-for="s in list" :key="s.id" class="px-5 py-3" :class="{ 'opacity-60': s.status === 'cancelled' }">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p class="text-[14px] font-medium">
                      {{ s.label }} <span class="font-normal text-ink-2 tnum">{{ shiftRange(s) }}</span>
                      <StatusBadge v-if="s.status === 'cancelled'" class="ml-2" tone="neutral" label="Cancelled" />
                    </p>
                    <p class="text-[12.5px] text-ink-3 tnum">Reporting {{ time(s.window_opens_at, s.timezone) }} – {{ time(s.window_closes_at, s.timezone) }}</p>
                  </div>
                  <UiButton size="sm" variant="ghost" :loading="busy === `cancel-${s.id}`" @click="toggleCancel(s)">{{ s.status === 'cancelled' ? 'Restore' : 'Cancel shift' }}</UiButton>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span v-for="a in s.assignees" :key="a.employee_id" class="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pr-1 pl-2.5 text-[13px]">
                    {{ a.full_name }}
                    <button class="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-sunken hover:text-bad" :aria-label="`Remove ${a.full_name}`" @click="unassign(s, a.employee_id)">✕</button>
                  </span>
                  <span v-if="!s.assignees.length" class="text-[13px] text-ink-3">No one yet</span>
                  <form v-if="s.status === 'scheduled'" class="flex items-center gap-1.5" @submit.prevent="assign(s)">
                    <select v-model="pick[s.id]" class="field-input h-8 w-40 py-0 text-[13px]" aria-label="Add worker">
                      <option :value="undefined" disabled>+ Add worker</option>
                      <option v-for="w in workers.filter((x) => !s.assignees.some((a) => a.employee_id === x.id))" :key="w.id" :value="w.id">{{ w.full_name }}</option>
                    </select>
                    <UiButton v-if="pick[s.id]" size="sm" type="submit" :loading="busy === `assign-${s.id}`">Add</UiButton>
                  </form>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </StateBlock>
    </section>

    <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit shift type' : 'Add shift type'" @close="editing = null">
      <form v-if="editing" id="type-form" class="space-y-4" @submit.prevent="saveType">
        <UiField v-slot="{ id }" label="Name" :error="errors.name"><input :id="id" v-model="editing.name" class="field-input" maxlength="80" placeholder="Morning" /></UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Starts" :error="errors.start_time"><input :id="id" v-model="editing.start_time" type="time" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Ends" :error="errors.end_time"><input :id="id" v-model="editing.end_time" type="time" class="field-input" /></UiField>
        </div>
        <p v-if="overnight" class="-mt-2 text-[12.5px] text-info">Overnight shift — ends the next day.</p>
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
        <UiButton variant="primary" type="submit" form="type-form" :loading="busy === 'type'">Save</UiButton>
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
