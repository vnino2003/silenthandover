<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { daysBetween, labelRange, LEAVE_STATUS, type LeaveStatus } from '@/lib/schedule';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * Request leave and follow each request. Only approved leave changes the schedule; a pending
 * request can be cancelled here, an approved one through the supervisor.
 */
interface LeaveType { id: string; name: string; description: string; requires_reason: boolean; max_days: number | null; is_active: boolean }
interface Request {
  id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  status: LeaveStatus;
  decision_note: string;
  decided_at: string | null;
  decided_by_name: string | null;
  created_at: string;
}

const toast = useToast();
const types = useAsync(() => api.get<LeaveType[]>('/leave-types'));
const { data, loading, error, reload } = useAsync(() => api.get<Request[]>('/leave'), [], { refreshMs: 60_000 });
const activeTypes = computed(() => (types.data.value ?? []).filter((t) => t.is_active));

const today = new Date().toISOString().slice(0, 10);
const upcoming = computed(() => (data.value ?? []).filter((r) => r.status === 'approved' && r.end_date >= today));
const pending = computed(() => (data.value ?? []).filter((r) => r.status === 'pending'));
const history = computed(() => (data.value ?? []).filter((r) => !pending.value.includes(r) && !upcoming.value.includes(r)));

// ---- Request form
const form = ref<{ leave_type_id: string; start_date: string; end_date: string; reason: string } | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const chosen = computed(() => activeTypes.value.find((t) => t.id === form.value?.leave_type_id) ?? null);
const dayCount = computed(() => (form.value?.start_date && form.value.end_date && form.value.end_date >= form.value.start_date ? daysBetween(form.value.start_date, form.value.end_date) + 1 : 0));
function openForm() {
  errors.value = {};
  form.value = { leave_type_id: activeTypes.value[0]?.id ?? '', start_date: today, end_date: today, reason: '' };
}
// Keep the last day on or after the first.
watch(() => form.value?.start_date, (s) => form.value && s && form.value.end_date < s && (form.value.end_date = s));
const formProblem = computed(() => {
  const f = form.value;
  if (!f || !chosen.value) return 'Choose a leave type';
  if (!dayCount.value) return 'Choose the first and last day';
  if (chosen.value.max_days && dayCount.value > chosen.value.max_days) return `${chosen.value.name} is up to ${chosen.value.max_days} days per request`;
  if (chosen.value.requires_reason && f.reason.trim().length < 3) return 'Add a short reason';
  return null;
});
async function submit() {
  if (!form.value || formProblem.value) return;
  saving.value = true;
  errors.value = {};
  try {
    await api.post('/leave', { ...form.value, reason: form.value.reason.trim() });
    toast.ok('Leave requested — your supervisor has been notified');
    form.value = null;
    await reload(true);
  } catch (err) {
    if (err instanceof ApiError) errors.value = err.fields;
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

// ---- Cancel a pending request
const cancelling = ref<Request | null>(null);
const busy = ref(false);
async function cancel() {
  if (!cancelling.value) return;
  busy.value = true;
  try {
    await api.post(`/leave/${cancelling.value.id}/cancel`, {});
    toast.ok('Request cancelled');
    cancelling.value = null;
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <PageHeader title="Leave" description="Request time off and follow each request. Approved leave appears on your schedule and your supervisor’s board.">
      <UiButton variant="primary" :disabled="!activeTypes.length" @click="openForm">Request leave</UiButton>
    </PageHeader>

    <StateBlock :loading="loading" :error="error" :empty="!data?.length" empty-title="No leave requests yet" empty-text="Request leave here instead of messaging your supervisor; you’ll be notified when they decide." @retry="reload()">
      <div v-if="data" class="space-y-7">
        <section v-for="group in [
          { title: 'Waiting for approval', rows: pending },
          { title: 'Upcoming approved leave', rows: upcoming },
          { title: 'History', rows: history },
        ].filter((g) => g.rows.length)" :key="group.title">
          <h2 class="mb-2 text-[13px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{{ group.title }}</h2>
          <ul class="stagger card divide-y divide-line">
            <li v-for="r in group.rows" :key="r.id" class="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
              <div class="min-w-0">
                <p class="text-[14.5px] font-semibold">{{ r.leave_type }} <span class="font-normal text-ink-3 tnum">· {{ r.days }} day{{ r.days === 1 ? '' : 's' }}</span></p>
                <p class="text-[13.5px] text-ink-2 tnum">{{ labelRange(r.start_date, r.end_date) }}</p>
                <p v-if="r.reason" class="mt-1 text-[13px] text-ink-3">Your reason: {{ r.reason }}</p>
                <p v-if="r.decided_by_name" class="mt-1 text-[13px]" :class="r.status === 'rejected' ? 'text-bad' : 'text-ink-2'">
                  {{ r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Not approved' : 'Decided' }} by {{ r.decided_by_name }}, {{ dateTime(r.decided_at!) }}<template v-if="r.decision_note"> — “{{ r.decision_note }}”</template>
                </p>
              </div>
              <div class="flex items-center gap-2">
                <StatusBadge :tone="LEAVE_STATUS[r.status].tone" :label="LEAVE_STATUS[r.status].label" />
                <UiButton v-if="r.status === 'pending'" size="sm" variant="ghost" @click="cancelling = r">Cancel</UiButton>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </StateBlock>

    <UiDialog :open="Boolean(form)" title="Request leave" description="Whole days. Your supervisor approves or declines it, and you’re notified either way." @close="form = null">
      <form v-if="form" id="leave-form" class="space-y-4" @submit.prevent="submit">
        <UiField v-slot="{ id }" label="Type of leave" :error="errors.leave_type_id">
          <select :id="id" v-model="form.leave_type_id" class="field-input">
            <option v-for="t in activeTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </UiField>
        <p v-if="chosen?.description" class="-mt-2 text-[12.5px] text-ink-3">{{ chosen.description }}</p>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="First day" :error="errors.start_date"><input :id="id" v-model="form.start_date" type="date" :min="today" class="field-input" /></UiField>
          <UiField v-slot="{ id }" label="Last day" :error="errors.end_date"><input :id="id" v-model="form.end_date" type="date" :min="form.start_date" class="field-input" /></UiField>
        </div>
        <p v-if="dayCount" class="-mt-2 text-[13px] text-ink-2 tnum">{{ dayCount }} day{{ dayCount === 1 ? '' : 's' }} · {{ labelRange(form.start_date, form.end_date) }}</p>
        <UiField v-slot="{ id }" :label="chosen?.requires_reason ? 'Reason' : 'Reason'" :optional="!chosen?.requires_reason" :error="errors.reason" hint="Only you and your approving supervisor can see this.">
          <textarea :id="id" v-model="form.reason" class="field-input" rows="3" maxlength="1000" />
        </UiField>
        <p v-if="formProblem" class="text-[12.5px] text-warn">{{ formProblem }}</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="form = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="leave-form" :loading="saving" :disabled="Boolean(formProblem)">Send request</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="Boolean(cancelling)" title="Cancel this leave request?" :description="cancelling ? `${cancelling.leave_type} · ${labelRange(cancelling.start_date, cancelling.end_date)}` : ''" @close="cancelling = null">
      <template #footer>
        <UiButton variant="ghost" @click="cancelling = null">Keep it</UiButton>
        <UiButton variant="danger" :loading="busy" @click="cancel">Cancel request</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
