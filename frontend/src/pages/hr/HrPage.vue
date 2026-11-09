<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSegment, IonSegmentButton, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage, fetchBlob } from '@/lib/api';
import { day } from '@/lib/format';
import { DTR_STATE, EXCEPTION_LABEL, minutes } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * HR timekeeping: cutoff periods and pay groups, DTR status across units, unresolved attendance
 * items, the period lock, and the CSV of certified totals. HR sees totals and statuses, not punches
 * or leave reasons.
 */
interface Overview {
  pay_groups: { id: string; name: string; employment_category: string; cutoff: string }[];
  periods: { id: string; pay_group_id: string; pay_group: string; start_date: string; end_date: string; pay_date: string; state: string; locked_at: string | null; members: number; certified: number }[];
  exceptions: { kind: string; department: string; open: number }[];
  staff: { id: string; full_name: string; job_title: string | null; department: string | null; pay_group_id: string | null }[];
  policy: { version: number; effective_from: string; rules: Record<string, unknown>; note: string } | null;
}
interface PeriodDtr { profile_id: string; full_name: string; department: string | null; version: number | null; state: string; totals: Record<string, number> | null; blocking_items: number | null }
const auth = useAuth();
const toast = useToast();
const tab = ref<'periods' | 'people' | 'items' | 'policy'>('periods');
const { data, loading, error, reload } = useAsync(() => api.get<Overview>('/hr/overview'));
const openPeriod = ref<string | null>(null);
const dtrs = useAsync(() => (openPeriod.value ? api.get<PeriodDtr[]>(`/hr/periods/${openPeriod.value}/dtrs`) : Promise.resolve([] as PeriodDtr[])), [openPeriod]);
const d = (iso: string) => day(`${iso}T12:00:00`);
const busy = ref('');
const isTimekeeper = computed(() => auth.can('timekeeper'));

const creating = ref<{ pay_group_id: string; start_date: string; end_date: string; pay_date: string } | null>(null);
const formError = ref('');
async function createPeriod() {
  if (!creating.value) return;
  busy.value = 'create';
  formError.value = '';
  try {
    await api.post('/hr/periods', creating.value);
    toast.ok('Cutoff period created');
    creating.value = null;
    await reload(true);
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    busy.value = '';
  }
}
async function lock(id: string) {
  busy.value = `lock-${id}`;
  try {
    await api.post(`/hr/periods/${id}/lock`);
    toast.ok('Period locked. Payroll can now prepare it.');
    await reload(true);
    if (openPeriod.value === id) await dtrs.reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
async function exportCsv(id: string) {
  try {
    const blob = await fetchBlob(`/hr/periods/${id}/export.csv`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dtr-totals-${id.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
async function setGroup(profileId: string, group: string) {
  try {
    await api.post('/hr/pay-group-members', { profile_id: profileId, pay_group_id: group || null });
    toast.ok('Pay group updated');
    await reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
const newPeriod = () => {
  const today = new Date().toISOString().slice(0, 10);
  const first = today.slice(0, 8) + (Number(today.slice(8)) <= 15 ? '01' : '16');
  const last = Number(today.slice(8)) <= 15 ? today.slice(0, 8) + '15' : new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  creating.value = { pay_group_id: data.value?.pay_groups[0]?.id ?? '', start_date: first, end_date: last, pay_date: last };
  formError.value = '';
};
const RULES: Record<string, string> = {
  employer_type: 'Employer type', grace_minutes: 'Grace period (min)', overtime_min_minutes: 'Overtime counted from (min)', overnight_attribution: 'Overnight duty',
  days_per_month: 'Working days per month', hours_per_day: 'Hours per day', night_start: 'Night hours start', night_end: 'Night hours end',
  night_rate: 'Night differential', overtime_rate: 'Overtime rate', cutoff: 'Cutoff',
};
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-5xl space-y-5">
          <PageHeader title="HR timekeeping" description="Cutoff periods, pay groups and DTR status across units. Lock a period once every DTR in its pay group is certified.">
            <UiButton v-if="isTimekeeper || auth.can('hr_admin')" size="sm" variant="primary" @click="newPeriod">New cutoff period</UiButton>
          </PageHeader>
          <IonSegment :value="tab" class="sh-segment" @ion-change="tab = ($event.detail.value as typeof tab)">
            <IonSegmentButton value="periods">Periods</IonSegmentButton>
            <IonSegmentButton value="people">Pay groups</IonSegmentButton>
            <IonSegmentButton value="items">Open items</IonSegmentButton>
            <IonSegmentButton value="policy">Rules</IonSegmentButton>
          </IonSegment>
          <StateBlock :loading="loading" :error="error" @retry="reload()">
            <template v-if="data && tab === 'periods'">
              <p v-if="!data.periods.length" class="card p-5 text-[14px] text-ink-3">No cutoff periods yet.</p>
              <article v-for="p in data.periods" :key="p.id" class="card mt-3 p-5">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <p class="font-medium">{{ d(p.start_date) }} – {{ d(p.end_date) }} <StatusBadge :tone="p.state === 'locked' ? 'ok' : 'info'" :label="p.state === 'locked' ? 'Locked' : 'Open'" /></p>
                    <p class="text-[13px] text-ink-3">{{ p.pay_group }} · pay date {{ d(p.pay_date) }} · {{ p.certified }} of {{ p.members }} DTRs certified</p>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <UiButton size="sm" variant="ghost" @click="openPeriod = openPeriod === p.id ? null : p.id">{{ openPeriod === p.id ? 'Hide DTRs' : 'Show DTRs' }}</UiButton>
                    <UiButton size="sm" variant="ghost" @click="exportCsv(p.id)">Export CSV</UiButton>
                    <UiButton v-if="p.state === 'open' && isTimekeeper" size="sm" variant="primary" :loading="busy === `lock-${p.id}`" @click="lock(p.id)">Lock period</UiButton>
                  </div>
                </div>
                <StateBlock v-if="openPeriod === p.id" :loading="dtrs.loading.value" :error="dtrs.error.value">
                  <ul class="mt-3 divide-y divide-line text-[14px]">
                    <li v-for="x in dtrs.data.value" :key="x.profile_id" class="flex flex-wrap items-center gap-2 py-2">
                      <span class="min-w-40 flex-1">{{ x.full_name }} <span class="text-ink-3">· {{ x.department ?? 'No unit' }}</span></span>
                      <span class="text-[13px] text-ink-3 tnum">{{ x.totals ? `${minutes(x.totals.worked_minutes)} worked · ${x.totals.absences} absences` : '' }}</span>
                      <StatusBadge :tone="DTR_STATE[x.state]?.tone" :label="DTR_STATE[x.state]?.label ?? x.state" />
                    </li>
                    <li v-if="!dtrs.data.value?.length" class="py-3 text-ink-3">Nobody in this pay group yet.</li>
                  </ul>
                </StateBlock>
              </article>
            </template>

            <template v-if="data && tab === 'people'">
              <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Pay group membership">
                <table class="w-full min-w-[600px] text-left text-[14px]">
                  <thead class="border-b border-line text-[12.5px] text-ink-3"><tr><th class="px-5 py-2.5 font-medium">Name</th><th class="px-3 py-2.5 font-medium">Unit</th><th class="px-5 py-2.5 font-medium">Pay group</th></tr></thead>
                  <tbody class="divide-y divide-line">
                    <tr v-for="s in data.staff" :key="s.id">
                      <td class="px-5 py-2">{{ s.full_name }}<span v-if="s.job_title" class="block text-[12.5px] text-ink-3">{{ s.job_title }}</span></td>
                      <td class="px-3 py-2 text-ink-2">{{ s.department ?? '—' }}</td>
                      <td class="px-5 py-2">
                        <IonSelect :value="s.pay_group_id ?? ''" class="field-input w-64" interface="popover" :aria-label="`Pay group of ${s.full_name}`" @ion-change="setGroup(s.id, String($event.detail.value ?? ''))">
                          <IonSelectOption value="">Not on payroll here</IonSelectOption>
                          <IonSelectOption v-for="g in data.pay_groups" :key="g.id" :value="g.id">{{ g.name }}</IonSelectOption>
                        </IonSelect>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>

            <template v-if="data && tab === 'items'">
              <section class="card p-5">
                <h2 class="text-[14px] font-semibold">Unresolved attendance items by unit</h2>
                <p class="mt-1 text-[13px] text-ink-3">The unit's department head settles these; a DTR can't be certified while they are open.</p>
                <ul class="mt-3 divide-y divide-line text-[14px]">
                  <li v-for="(x, i) in data.exceptions" :key="i" class="flex justify-between py-2"><span>{{ x.department }} · {{ EXCEPTION_LABEL[x.kind] ?? x.kind }}</span><span class="tnum">{{ x.open }}</span></li>
                  <li v-if="!data.exceptions.length" class="py-2 text-ink-3">Nothing open.</li>
                </ul>
              </section>
            </template>

            <template v-if="data && tab === 'policy'">
              <section v-if="data.policy" class="card p-5">
                <h2 class="text-[14px] font-semibold">Attendance and pay rules · version {{ data.policy.version }} (from {{ d(data.policy.effective_from) }})</h2>
                <p v-if="data.policy.rules.sample" class="mt-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">{{ data.policy.note }}</p>
                <dl class="mt-3 grid gap-2 text-[14px] sm:grid-cols-2">
                  <div v-for="(label, key) in RULES" :key="key" class="flex justify-between gap-3 border-b border-line py-1.5">
                    <dt class="text-ink-3">{{ label }}</dt>
                    <dd class="tnum">{{ key === 'night_rate' ? `${Number(data.policy.rules[key]) * 100}%` : key === 'overtime_rate' ? `${Number(data.policy.rules[key]) * 100}%` : String(data.policy.rules[key]).replace(/_/g, ' ') }}</dd>
                  </div>
                </dl>
              </section>
            </template>
          </StateBlock>
        </div>

        <UiDialog :open="Boolean(creating)" title="New cutoff period" description="Up to 31 days, without overlapping another period of the pay group." @close="creating = null">
          <form v-if="creating" id="period-form" class="space-y-4" @submit.prevent="createPeriod">
            <UiField v-slot="{ labelledby }" label="Pay group">
              <IonSelect v-model="creating.pay_group_id" class="field-input" interface="popover" :aria-labelledby="labelledby">
                <IonSelectOption v-for="g in data?.pay_groups" :key="g.id" :value="g.id">{{ g.name }}</IonSelectOption>
              </IonSelect>
            </UiField>
            <div class="grid gap-3 sm:grid-cols-3">
              <UiField v-slot="{ id, labelledby }" label="First day"><IonInput :id="id" v-model="creating.start_date" :aria-labelledby="labelledby" class="field-input" type="date" /></UiField>
              <UiField v-slot="{ id, labelledby }" label="Last day"><IonInput :id="id" v-model="creating.end_date" :aria-labelledby="labelledby" class="field-input" type="date" /></UiField>
              <UiField v-slot="{ id, labelledby }" label="Pay date"><IonInput :id="id" v-model="creating.pay_date" :aria-labelledby="labelledby" class="field-input" type="date" /></UiField>
            </div>
            <p v-if="formError" role="alert" class="text-[13px] text-bad">{{ formError }}</p>
          </form>
          <template #footer>
            <UiButton variant="ghost" @click="creating = null">Cancel</UiButton>
            <UiButton variant="primary" type="submit" form="period-form" :loading="busy === 'create'">Create</UiButton>
          </template>
        </UiDialog>
      </div>
    </IonContent>
  </IonPage>
</template>
