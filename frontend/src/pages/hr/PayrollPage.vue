<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSegment, IonSegmentButton, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { day } from '@/lib/format';
import { minutes, peso, RUN_STATE } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * Payroll and Finance. Payroll prepares a run from a LOCKED period's certified DTRs and submits it;
 * Finance, a different person, approves or returns it and releases it to staff. Inputs are the
 * certified totals only. The demo pay rules are labelled samples.
 */
interface Run { id: string; period_id: string; state: string; totals: { people?: number; earnings?: number; deductions?: number; net?: number }; prepared_at: string; submitted_at: string | null; approved_at: string | null; released_at: string | null; decision_note: string; prepared_by_name: string; approved_by_name: string | null; prepared_by: string; start_date: string; end_date: string }
interface Overview {
  periods: { id: string; pay_group: string; start_date: string; end_date: string; pay_date: string; state: string }[];
  runs: Run[];
  compensation: { profile_id: string; full_name: string; department: string | null; current: { monthly_basic: number; effective_from: string } | null }[];
  policy: { version: number; rules: Record<string, unknown>; note: string } | null;
}
interface RunDetail { run: Run; people: { profile_id: string; full_name: string; dtr_version: number; dtr_totals: Record<string, number>; lines: { kind: string; code: string; label: string; quantity: string; rate: string; amount: string }[]; net: string }[] }
const auth = useAuth();
const toast = useToast();
const tab = ref<'runs' | 'pay'>('runs');
const { data, loading, error, reload } = useAsync(() => api.get<Overview>('/payroll/overview'));
const openRun = ref<string | null>(null);
const detail = useAsync(() => (openRun.value ? api.get<RunDetail>(`/payroll/runs/${openRun.value}`) : Promise.resolve(null)), [openRun]);
const d = (iso: string) => day(`${iso}T12:00:00`);
const busy = ref('');
const canPrepare = computed(() => auth.can('payroll_preparer'));
const canApprove = computed(() => auth.can('finance_approver'));
const canSetPay = computed(() => auth.can('hr_admin'));
const unprepared = computed(() => (data.value?.periods ?? []).filter((p) => !(data.value?.runs ?? []).some((r) => r.period_id === p.id && r.state !== 'returned')));

async function act(key: string, fn: () => Promise<unknown>, done: string) {
  busy.value = key;
  try {
    await fn();
    toast.ok(done);
    await reload(true);
    if (openRun.value) await detail.reload(true);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  } finally {
    busy.value = '';
  }
}
async function prepare(period: string) {
  busy.value = `prep-${period}`;
  try {
    const res = await api.post<{ id: string }>('/payroll/runs', { period_id: period });
    toast.ok('Draft run prepared');
    await reload(true);
    openRun.value = res.id;
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
const submitRun = (r: Run) => act(`sub-${r.id}`, () => api.post(`/payroll/runs/${r.id}/submit`), 'Submitted to Finance');
const releaseRun = (r: Run) => act(`rel-${r.id}`, () => api.post(`/finance/runs/${r.id}/release`), 'Released; staff can see their payslips');
const deciding = ref<{ run: Run; decision: 'approved' | 'returned'; note: string } | null>(null);
async function decide() {
  const x = deciding.value;
  if (!x) return;
  if (await act('decide', () => api.post(`/finance/runs/${x.run.id}/decision`, { decision: x.decision, note: x.note }), x.decision === 'approved' ? 'Payroll approved' : 'Returned to Payroll')) deciding.value = null;
}
const editing = ref<{ profile_id: string; name: string; monthly_basic: string; effective_from: string } | null>(null);
async function saveComp() {
  const x = editing.value;
  if (!x) return;
  if (await act('comp', () => api.put(`/payroll/compensation/${x.profile_id}`, { monthly_basic: Number(x.monthly_basic), effective_from: x.effective_from }), 'Compensation saved')) editing.value = null;
}
const adjusting = ref<{ profile_id: string; kind: 'earning' | 'deduction'; amount: string; label: string; reason: string } | null>(null);
async function saveAdj() {
  const x = adjusting.value;
  if (!x) return;
  if (await act('adj', () => api.post('/payroll/adjustments', { ...x, amount: Number(x.amount), for_period_id: null }), 'Adjustment added to the next run')) adjusting.value = null;
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-5xl space-y-5">
          <PageHeader title="Payroll" description="Prepared from certified DTRs of locked periods. Finance approves (never the preparer) and releases payslips." />
          <p v-if="data?.policy?.rules.sample" class="rounded-md bg-warn-soft px-4 py-2.5 text-[13px] text-warn">Sample pay rules (version {{ data.policy.version }}): {{ data.policy.note }} Taxes and statutory contributions are not computed.</p>
          <IonSegment :value="tab" class="sh-segment" @ion-change="tab = ($event.detail.value as typeof tab)">
            <IonSegmentButton value="runs">Runs</IonSegmentButton>
            <IonSegmentButton value="pay">Pay settings</IonSegmentButton>
          </IonSegment>
          <StateBlock :loading="loading" :error="error" @retry="reload()">
            <template v-if="data && tab === 'runs'">
              <section v-if="canPrepare && unprepared.length" class="card p-5">
                <h2 class="text-[14px] font-semibold">Locked periods ready for payroll</h2>
                <ul class="mt-2 divide-y divide-line text-[14px]">
                  <li v-for="p in unprepared" :key="p.id" class="flex items-center gap-2 py-2">
                    <span class="flex-1">{{ p.pay_group }} · {{ d(p.start_date) }} – {{ d(p.end_date) }}</span>
                    <UiButton size="sm" variant="primary" :loading="busy === `prep-${p.id}`" @click="prepare(p.id)">Prepare run</UiButton>
                  </li>
                </ul>
              </section>
              <p v-if="!data.runs.length" class="card mt-3 p-5 text-[14px] text-ink-3">No payroll runs yet. HR locks a period first.</p>
              <article v-for="r in data.runs" :key="r.id" class="card mt-3 p-5">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <p class="font-medium">{{ d(r.start_date) }} – {{ d(r.end_date) }} <StatusBadge :tone="RUN_STATE[r.state]?.tone" :label="RUN_STATE[r.state]?.label ?? r.state" /></p>
                    <p class="text-[13px] text-ink-3 tnum">{{ r.totals.people ?? 0 }} people · net {{ peso(r.totals.net ?? 0) }} · prepared by {{ r.prepared_by_name }}<template v-if="r.approved_by_name"> · decided by {{ r.approved_by_name }}</template></p>
                    <p v-if="r.decision_note" class="text-[13px] text-ink-2">{{ r.decision_note }}</p>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <UiButton size="sm" variant="ghost" @click="openRun = openRun === r.id ? null : r.id">{{ openRun === r.id ? 'Hide' : 'Details' }}</UiButton>
                    <UiButton v-if="r.state === 'draft' && r.prepared_by === auth.profile?.id" size="sm" variant="primary" :loading="busy === `sub-${r.id}`" @click="submitRun(r)">Submit to Finance</UiButton>
                    <template v-if="canApprove && r.state === 'submitted' && r.prepared_by !== auth.profile?.id">
                      <UiButton size="sm" variant="primary" @click="deciding = { run: r, decision: 'approved', note: '' }">Approve</UiButton>
                      <UiButton size="sm" variant="ghost" @click="deciding = { run: r, decision: 'returned', note: '' }">Return</UiButton>
                    </template>
                    <UiButton v-if="canApprove && r.state === 'approved'" size="sm" variant="primary" :loading="busy === `rel-${r.id}`" @click="releaseRun(r)">Release payslips</UiButton>
                  </div>
                </div>
                <StateBlock v-if="openRun === r.id" :loading="detail.loading.value" :error="detail.error.value">
                  <div v-for="p in detail.data.value?.people" :key="p.profile_id" class="mt-4 border-t border-line pt-3">
                    <div class="flex flex-wrap items-baseline justify-between gap-2">
                      <p class="font-medium">{{ p.full_name }}</p>
                      <p class="text-[12.5px] text-ink-3 tnum">DTR v{{ p.dtr_version }} · worked {{ minutes(p.dtr_totals?.worked_minutes) }} · night {{ minutes(p.dtr_totals?.night_minutes) }}</p>
                    </div>
                    <table class="mt-1 w-full text-[13.5px] tnum">
                      <tbody>
                        <tr v-for="(l, i) in p.lines" :key="i"><td class="py-0.5">{{ l.label }}</td><td class="py-0.5 text-right text-ink-3">{{ Number(l.quantity) }} × {{ Number(l.rate) }}</td><td class="w-32 py-0.5 text-right" :class="l.kind === 'deduction' ? 'text-bad' : ''">{{ l.kind === 'deduction' ? '−' : '' }}{{ peso(l.amount) }}</td></tr>
                        <tr class="font-semibold"><td class="pt-1">Net</td><td /><td class="pt-1 text-right">{{ peso(p.net) }}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </StateBlock>
              </article>
            </template>

            <template v-if="data && tab === 'pay'">
              <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Compensation settings">
                <table class="w-full min-w-[560px] text-left text-[14px]">
                  <thead class="border-b border-line text-[12.5px] text-ink-3"><tr><th class="px-5 py-2.5 font-medium">Name</th><th class="px-3 py-2.5 font-medium">Monthly basic</th><th class="px-3 py-2.5 font-medium">From</th><th class="px-5 py-2.5" /></tr></thead>
                  <tbody class="divide-y divide-line tnum">
                    <tr v-for="c in data.compensation" :key="c.profile_id">
                      <td class="px-5 py-2">{{ c.full_name }}<span class="block text-[12.5px] text-ink-3">{{ c.department ?? '' }}</span></td>
                      <td class="px-3 py-2">{{ c.current ? peso(c.current.monthly_basic) : '—' }}</td>
                      <td class="px-3 py-2">{{ c.current ? d(c.current.effective_from) : '—' }}</td>
                      <td class="px-5 py-2 text-right whitespace-nowrap">
                        <UiButton v-if="canSetPay && c.profile_id !== auth.profile?.id" size="sm" variant="ghost" @click="editing = { profile_id: c.profile_id, name: c.full_name, monthly_basic: String(c.current?.monthly_basic ?? ''), effective_from: c.current?.effective_from ?? new Date().toISOString().slice(0, 10) }">Set pay</UiButton>
                        <UiButton v-if="(canPrepare || canSetPay) && c.profile_id !== auth.profile?.id" size="sm" variant="ghost" @click="adjusting = { profile_id: c.profile_id, kind: 'earning', amount: '', label: '', reason: '' }">Adjustment</UiButton>
                      </td>
                    </tr>
                    <tr v-if="!data.compensation.length"><td colspan="4" class="px-5 py-6 text-center text-ink-3">Nobody is in a pay group yet (HR timekeeping → Pay groups).</td></tr>
                  </tbody>
                </table>
              </div>
            </template>
          </StateBlock>
        </div>

        <UiDialog :open="Boolean(deciding)" :title="deciding?.decision === 'approved' ? 'Approve this payroll?' : 'Return to Payroll'" :description="deciding ? `${d(deciding.run.start_date)} – ${d(deciding.run.end_date)} · net ${peso(deciding.run.totals.net ?? 0)}` : ''" @close="deciding = null">
          <form v-if="deciding" id="decide-form" @submit.prevent="decide">
            <UiField v-slot="{ id, labelledby }" :label="deciding.decision === 'approved' ? 'Note' : 'What must be fixed'" :optional="deciding.decision === 'approved'"><IonInput :id="id" v-model="deciding.note" :aria-labelledby="labelledby" class="field-input" :maxlength="500" /></UiField>
          </form>
          <template #footer>
            <UiButton variant="ghost" @click="deciding = null">Cancel</UiButton>
            <UiButton variant="primary" type="submit" form="decide-form" :loading="busy === 'decide'">{{ deciding?.decision === 'approved' ? 'Approve' : 'Return' }}</UiButton>
          </template>
        </UiDialog>
        <UiDialog :open="Boolean(editing)" title="Monthly basic pay" :description="editing?.name" @close="editing = null">
          <form v-if="editing" id="comp-form" class="grid gap-3 sm:grid-cols-2" @submit.prevent="saveComp">
            <UiField v-slot="{ id, labelledby }" label="Monthly basic (PHP)"><IonInput :id="id" v-model="editing.monthly_basic" :aria-labelledby="labelledby" class="field-input" type="number" inputmode="decimal" /></UiField>
            <UiField v-slot="{ id, labelledby }" label="Effective from"><IonInput :id="id" v-model="editing.effective_from" :aria-labelledby="labelledby" class="field-input" type="date" /></UiField>
          </form>
          <template #footer>
            <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
            <UiButton variant="primary" type="submit" form="comp-form" :loading="busy === 'comp'">Save</UiButton>
          </template>
        </UiDialog>
        <UiDialog :open="Boolean(adjusting)" title="Adjustment for the next run" description="For corrections after a period was locked. It appears as its own line." @close="adjusting = null">
          <form v-if="adjusting" id="adj-form" class="space-y-3" @submit.prevent="saveAdj">
            <UiField v-slot="{ labelledby }" label="Type">
              <IonSelect v-model="adjusting.kind" class="field-input" interface="popover" :aria-labelledby="labelledby"><IonSelectOption value="earning">Add to pay</IonSelectOption><IonSelectOption value="deduction">Deduct</IonSelectOption></IonSelect>
            </UiField>
            <UiField v-slot="{ id, labelledby }" label="Amount (PHP)"><IonInput :id="id" v-model="adjusting.amount" :aria-labelledby="labelledby" class="field-input" type="number" inputmode="decimal" /></UiField>
            <UiField v-slot="{ id, labelledby }" label="Label" hint="Shown on the payslip, e.g. Night differential, 2–15 Oct"><IonInput :id="id" v-model="adjusting.label" :aria-labelledby="labelledby" class="field-input" :maxlength="120" /></UiField>
            <UiField v-slot="{ id, labelledby }" label="Reason"><IonInput :id="id" v-model="adjusting.reason" :aria-labelledby="labelledby" class="field-input" :maxlength="500" /></UiField>
          </form>
          <template #footer>
            <UiButton variant="ghost" @click="adjusting = null">Cancel</UiButton>
            <UiButton variant="primary" type="submit" form="adj-form" :loading="busy === 'adj'">Add</UiButton>
          </template>
        </UiDialog>
      </div>
    </IonContent>
  </IonPage>
</template>
