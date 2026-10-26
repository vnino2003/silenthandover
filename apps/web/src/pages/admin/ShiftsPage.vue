<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { day, shiftRange, time } from '@/lib/format';
import { useAdminRefs } from '@/lib/useAdminRefs';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

interface Template {
  id: string;
  department_id: string;
  department_name: string;
  team_id: string | null;
  team_name: string | null;
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
  department_id: string;
  department_name: string;
  team_name: string | null;
  supervisor_id: string | null;
  supervisor_name: string | null;
  assignees: { employee_id: string; full_name: string }[];
}

const toast = useToast();
const refs = useAdminRefs();
const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const dept = ref<string>('');
const from = ref(isoDay(-1));
const to = ref(isoDay(6));
watch(
  () => refs.departments.data.value,
  (d) => {
    if (d?.length && !dept.value) dept.value = d[0]!.id;
  },
);

const templates = useAsync(() => api.get<Template[]>('/admin/templates'));
const shifts = useAsync(() => (dept.value ? api.get<Shift[]>(`/admin/shifts?department_id=${dept.value}&from=${from.value}&to=${to.value}`) : Promise.resolve([])), [dept, from, to]);
const deptTemplates = computed(() => (templates.data.value ?? []).filter((t) => t.department_id === dept.value));
const byDate = computed(() => {
  const groups = new Map<string, Shift[]>();
  for (const s of shifts.data.value ?? []) groups.set(s.shift_date, [...(groups.get(s.shift_date) ?? []), s]);
  return [...groups];
});

const busy = ref<string | null>(null);
const errors = ref<Record<string, string>>({});
async function run(key: string, fn: () => Promise<unknown>, done: string, after: () => Promise<unknown> = () => shifts.reload(true)) {
  busy.value = key;
  errors.value = {};
  try {
    await fn();
    toast.ok(done);
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

// Templates
const tpl = ref<Omit<Template, 'id' | 'department_name' | 'team_name' | 'overnight'> & { id: string | null } | null>(null);
function newTemplate() {
  tpl.value = { id: null, department_id: dept.value, team_id: null, name: '', start_time: '06:00', end_time: '14:00', window_open_minutes: 30, grace_minutes: 30, allow_early_draft: true, is_active: true };
}
async function saveTemplate() {
  const { id, ...body } = tpl.value!;
  const ok = await run('tpl', () => (id ? api.patch(`/admin/templates/${id}`, body) : api.post('/admin/templates', body)), 'Template saved', () => templates.reload(true));
  if (ok) tpl.value = null;
}
const overnight = computed(() => (tpl.value ? tpl.value.end_time <= tpl.value.start_time : false));

const gen = ref<{ template: Template; from: string; to: string; supervisor_id: string | null } | null>(null);
async function generate() {
  const g = gen.value!;
  let created = 0;
  const ok = await run('gen', async () => {
    created = (await api.post<{ created: number }>(`/admin/templates/${g.template.id}/generate`, { from: g.from, to: g.to, supervisor_id: g.supervisor_id })).created;
  }, 'Shifts generated');
  if (ok) {
    toast.info(`${created} new shift${created === 1 ? '' : 's'} created; existing dates were skipped`);
    gen.value = null;
  }
}

// One-off shift
const adhoc = ref<{ label: string; team_id: string | null; starts: string; ends: string; window_open_minutes: number; grace_minutes: number; supervisor_id: string | null } | null>(null);
async function createAdhoc() {
  const a = adhoc.value!;
  const ok = await run('adhoc', () =>
    api.post('/admin/shifts', {
      department_id: dept.value,
      team_id: a.team_id,
      label: a.label,
      starts_at: new Date(a.starts).toISOString(),
      ends_at: new Date(a.ends).toISOString(),
      window_open_minutes: a.window_open_minutes,
      grace_minutes: a.grace_minutes,
      supervisor_id: a.supervisor_id,
    }), 'Shift created');
  if (ok) adhoc.value = null;
}

const assignPick = ref<Record<string, string>>({});
const assign = (s: Shift) => {
  const employee_id = assignPick.value[s.id];
  if (!employee_id) return;
  void run(`assign-${s.id}`, async () => {
    const r = await api.post<{ handovers_delivered: number }>(`/admin/shifts/${s.id}/assignments`, { employee_id });
    if (r.handovers_delivered) toast.info(`${r.handovers_delivered} waiting handover(s) delivered to this employee`);
    assignPick.value[s.id] = '';
  }, 'Employee assigned');
};
const unassign = (s: Shift, employeeId: string) => run(`un-${s.id}-${employeeId}`, () => api.del(`/admin/shifts/${s.id}/assignments/${employeeId}`), 'Removed from shift');
const setSupervisor = (s: Shift, value: string) => run(`sup-${s.id}`, () => api.patch(`/admin/shifts/${s.id}`, { supervisor_id: value || null, status: s.status }), 'Supervisor updated');
const cancel = (s: Shift) => run(`cancel-${s.id}`, () => api.patch(`/admin/shifts/${s.id}`, { supervisor_id: s.supervisor_id, status: s.status === 'cancelled' ? 'scheduled' : 'cancelled' }), s.status === 'cancelled' ? 'Shift restored' : 'Shift cancelled');
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader title="Shifts" description="Templates define times and reporting windows. Concrete shifts are generated in the department’s time zone.">
      <select v-model="dept" class="field-input h-9 w-56 py-0 text-[14px]" aria-label="Department">
        <option v-for="d in refs.departments.data.value ?? []" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
    </PageHeader>

    <section class="mb-8">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="text-[15px] font-semibold">Templates</h2>
        <UiButton size="sm" @click="newTemplate">Add template</UiButton>
      </div>
      <StateBlock :loading="templates.loading.value" :error="templates.error.value" :empty="!deptTemplates.length" empty-title="No templates for this department">
        <div class="card overflow-x-auto">
          <table class="w-full min-w-[640px] text-left text-[14px]">
            <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
              <tr><th class="px-5 py-2.5 font-medium">Name</th><th class="px-3 py-2.5 font-medium">Hours</th><th class="px-3 py-2.5 font-medium">Reporting window</th><th class="px-3 py-2.5 font-medium">Status</th><th class="px-5 py-2.5" /></tr>
            </thead>
            <tbody class="divide-y divide-line">
              <tr v-for="t in deptTemplates" :key="t.id">
                <td class="px-5 py-2.5 font-medium">{{ t.name }}<span v-if="t.team_name" class="block text-[12.5px] font-normal text-ink-3">{{ t.team_name }}</span></td>
                <td class="px-3 py-2.5 tnum">{{ t.start_time }}–{{ t.end_time }}<span v-if="t.overnight" class="ml-1 text-[12.5px] text-ink-3">overnight</span></td>
                <td class="px-3 py-2.5 text-ink-2">Opens {{ t.window_open_minutes }} min before end · {{ t.grace_minutes }} min grace</td>
                <td class="px-3 py-2.5"><StatusBadge :tone="t.is_active ? 'ok' : 'neutral'" :label="t.is_active ? 'Active' : 'Inactive'" /></td>
                <td class="px-5 py-2.5 text-right whitespace-nowrap">
                  <UiButton size="sm" variant="ghost" @click="gen = { template: t, from, to, supervisor_id: null }">Generate</UiButton>
                  <UiButton size="sm" variant="ghost" @click="tpl = { ...t }">Edit</UiButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <section>
      <div class="mb-2 flex flex-wrap items-end justify-between gap-3">
        <h2 class="text-[15px] font-semibold">Schedule</h2>
        <div class="flex flex-wrap items-center gap-2">
          <input v-model="from" type="date" class="field-input h-9 w-40 py-0 text-[14px]" aria-label="From" />
          <span class="text-ink-3">–</span>
          <input v-model="to" type="date" class="field-input h-9 w-40 py-0 text-[14px]" aria-label="To" />
          <UiButton size="sm" @click="adhoc = { label: '', team_id: null, starts: '', ends: '', window_open_minutes: 30, grace_minutes: 30, supervisor_id: null }">One-off shift</UiButton>
        </div>
      </div>
      <StateBlock :loading="shifts.loading.value" :error="shifts.error.value" :empty="!byDate.length" empty-title="No shifts in this range" empty-text="Generate them from a template." @retry="shifts.reload()">
        <div class="space-y-5">
          <div v-for="[date, list] in byDate" :key="date">
            <p class="eyebrow mb-1.5">{{ day(date) }}</p>
            <ul class="card divide-y divide-line">
              <li v-for="s in list" :key="s.id" class="px-5 py-3" :class="{ 'opacity-60': s.status === 'cancelled' }">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-[14px] font-medium">{{ s.label }}<span v-if="s.team_name" class="font-normal text-ink-3"> · {{ s.team_name }}</span>
                      <StatusBadge v-if="s.status === 'cancelled'" class="ml-2" tone="neutral" label="Cancelled" /></p>
                    <p class="text-[12.5px] text-ink-3 tnum">{{ shiftRange(s) }} · window {{ time(s.window_opens_at, s.timezone) }}–{{ time(s.window_closes_at, s.timezone) }}</p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <select class="field-input h-8 w-44 py-0 text-[13px]" :value="s.supervisor_id ?? ''" aria-label="Supervisor" @change="setSupervisor(s, ($event.target as HTMLSelectElement).value)">
                      <option value="">No supervisor</option>
                      <option v-for="m in refs.managersFor(s.department_id)" :key="m.id" :value="m.id">{{ m.full_name }}</option>
                    </select>
                    <UiButton size="sm" variant="ghost" :loading="busy === `cancel-${s.id}`" @click="cancel(s)">{{ s.status === 'cancelled' ? 'Restore' : 'Cancel' }}</UiButton>
                  </div>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span v-for="a in s.assignees" :key="a.employee_id" class="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pr-1 pl-2.5 text-[12.5px]">
                    {{ a.full_name }}
                    <button class="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-sunken hover:text-bad" :aria-label="`Remove ${a.full_name}`" @click="unassign(s, a.employee_id)">✕</button>
                  </span>
                  <form v-if="s.status === 'scheduled'" class="flex items-center gap-1.5" @submit.prevent="assign(s)">
                    <select v-model="assignPick[s.id]" class="field-input h-8 w-44 py-0 text-[13px]" aria-label="Assign employee">
                      <option value="">Assign employee…</option>
                      <option v-for="e in refs.employeesFor(s.department_id).filter((x) => !s.assignees.some((a) => a.employee_id === x.id))" :key="e.id" :value="e.id">{{ e.full_name }}</option>
                    </select>
                    <UiButton v-if="assignPick[s.id]" size="sm" type="submit" :loading="busy === `assign-${s.id}`">Add</UiButton>
                  </form>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </StateBlock>
    </section>

    <UiDialog :open="Boolean(tpl)" :title="tpl?.id ? 'Edit template' : 'Add template'" @close="tpl = null">
      <form v-if="tpl" id="tpl-form" class="space-y-4" @submit.prevent="saveTemplate">
        <UiField v-slot="{ id }" label="Name" :error="errors.name"><input :id="id" v-model="tpl.name" class="field-input" maxlength="80" placeholder="Morning" /></UiField>
        <UiField v-if="refs.teamsFor(tpl.department_id).length" v-slot="{ id }" label="Team" optional>
          <select :id="id" v-model="tpl.team_id" class="field-input">
            <option :value="null">Whole department</option>
            <option v-for="t in refs.teamsFor(tpl.department_id)" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Starts" :error="errors.start_time"><input :id="id" v-model="tpl.start_time" type="time" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Ends" :error="errors.end_time"><input :id="id" v-model="tpl.end_time" type="time" class="field-input" /></UiField>
        </div>
        <p v-if="overnight" class="-mt-2 text-[12.5px] text-info">Overnight shift — ends the next day.</p>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Window opens (min before end)"><input :id="id" v-model.number="tpl.window_open_minutes" type="number" min="5" max="240" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Grace after end (min)"><input :id="id" v-model.number="tpl.grace_minutes" type="number" min="0" max="240" class="field-input" /></UiField>
        </div>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="tpl.allow_early_draft" type="checkbox" class="size-4 accent-accent" /> Allow drafts before the window opens</label>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="tpl.is_active" type="checkbox" class="size-4 accent-accent" /> Active</label>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="tpl = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="tpl-form" :loading="busy === 'tpl'">Save template</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(gen)" :title="`Generate ${gen?.template.name ?? ''} shifts`" description="One shift per day. Dates that already have this shift are skipped." @close="gen = null">
      <form v-if="gen" id="gen-form" class="space-y-4" @submit.prevent="generate">
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="From"><input :id="id" v-model="gen.from" type="date" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="To"><input :id="id" v-model="gen.to" type="date" class="field-input" /></UiField>
        </div>
        <UiField v-slot="{ id }" label="Supervisor" optional>
          <select :id="id" v-model="gen.supervisor_id" class="field-input">
            <option :value="null">None</option>
            <option v-for="m in refs.managersFor(gen.template.department_id)" :key="m.id" :value="m.id">{{ m.full_name }}</option>
          </select>
        </UiField>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="gen = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="gen-form" :loading="busy === 'gen'">Generate</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(adhoc)" title="One-off shift" description="For cover shifts or changes outside the regular templates." @close="adhoc = null">
      <form v-if="adhoc" id="adhoc-form" class="space-y-4" @submit.prevent="createAdhoc">
        <UiField v-slot="{ id }" label="Label" :error="errors.label"><input :id="id" v-model="adhoc.label" class="field-input" maxlength="80" placeholder="Cover — Dock 2" /></UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Starts" :error="errors.starts_at"><input :id="id" v-model="adhoc.starts" type="datetime-local" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Ends" :error="errors.ends_at"><input :id="id" v-model="adhoc.ends" type="datetime-local" class="field-input" /></UiField>
        </div>
        <p class="-mt-2 text-[12.5px] text-ink-3">Times are entered in your browser’s time zone.</p>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Window opens (min before end)"><input :id="id" v-model.number="adhoc.window_open_minutes" type="number" min="5" max="240" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Grace (min)"><input :id="id" v-model.number="adhoc.grace_minutes" type="number" min="0" max="240" class="field-input" /></UiField>
        </div>
        <UiField v-if="refs.teamsFor(dept).length" v-slot="{ id }" label="Team" optional>
          <select :id="id" v-model="adhoc.team_id" class="field-input">
            <option :value="null">Whole department</option>
            <option v-for="t in refs.teamsFor(dept)" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </UiField>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="adhoc = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="adhoc-form" :loading="busy === 'adhoc'" :disabled="!adhoc?.starts || !adhoc?.ends || (adhoc?.label.trim().length ?? 0) < 2">Create shift</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
