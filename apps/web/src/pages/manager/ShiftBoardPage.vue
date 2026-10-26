<script setup lang="ts">
import { ref } from 'vue';
import type { ReportStatus } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, day, shiftRange, time } from '@/lib/format';
import type { ShiftView } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

interface Assignee {
  employee_id: string;
  employee_name: string;
  report_id: string | null;
  report_status: ReportStatus | null;
  reference_code: string | null;
  is_late: boolean | null;
  override_expires_at: string | null;
  missing: boolean;
  incoming_delivery: { reference: string; acknowledged_at: string | null }[] | null;
}
interface Board {
  date: string;
  timezone: string;
  shifts: (ShiftView & { phase: 'upcoming' | 'active' | 'reporting' | 'ended'; assignees: Assignee[] })[];
}

const toast = useToast();
const date = ref('');
const { data, loading, error, reload } = useAsync(() => api.get<Board>(`/manager/shift-board${date.value ? `?date=${date.value}` : ''}`), [date]);

const PHASE: Record<string, string> = { upcoming: 'Upcoming', active: 'On shift', reporting: 'Reporting window', ended: 'Ended' };

const override = ref<{ shift: Board['shifts'][number]; person: Assignee } | null>(null);
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
    <PageHeader title="Today’s shifts" description="Who is on duty, whether they reported, and whether the next shift read its handover. Change who is on duty in Schedule.">
      <input v-model="date" type="date" class="field-input h-9 w-44 py-0 text-[14px]" aria-label="Date" />
    </PageHeader>
    <StateBlock :loading="loading" :error="error" :empty="!data?.shifts.length" empty-title="No shifts on this day" @retry="reload()">
      <div v-if="data" class="space-y-4">
        <p class="text-[13px] text-ink-3">Showing {{ day(data.date) }} and the day before · times in {{ data.timezone }}</p>
        <article v-for="s in data.shifts" :key="s.id" class="card">
          <header class="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
            <div>
              <h2 class="text-[15px] font-semibold">{{ s.label }}</h2>
              <p class="text-[13px] text-ink-3 tnum">{{ day(s.starts_at, s.timezone) }} · {{ shiftRange(s) }} · window {{ time(s.window_opens_at, s.timezone) }}–{{ time(s.window_closes_at, s.timezone) }}</p>
            </div>
            <StatusBadge :tone="s.phase === 'reporting' ? 'accent' : s.phase === 'active' ? 'info' : 'neutral'" :label="PHASE[s.phase]" />
          </header>
          <ul v-if="s.assignees.length" class="divide-y divide-line">
            <li v-for="a in s.assignees" :key="a.employee_id" class="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
              <div class="min-w-0">
                <p class="text-[14px] font-medium">{{ a.employee_name }}</p>
                <p v-if="a.incoming_delivery?.length" class="text-[12.5px] tnum" :class="a.incoming_delivery.every((d) => d.acknowledged_at) ? 'text-ok' : 'text-warn'">
                  Incoming handover {{ a.incoming_delivery.every((d) => d.acknowledged_at) ? 'acknowledged' : 'not yet acknowledged' }}
                </p>
                <p v-if="a.override_expires_at" class="text-[12.5px] text-info">Override until {{ time(a.override_expires_at, s.timezone) }}</p>
              </div>
              <div class="flex items-center gap-2">
                <RouterLink v-if="a.report_id && a.report_status !== 'draft'" :to="`/manager/reports/${a.report_id}`"><StatusBadge :report="a.report_status" /></RouterLink>
                <StatusBadge v-else-if="a.missing" tone="bad" label="Missing report" />
                <StatusBadge v-else-if="a.report_status === 'draft'" report="draft" />
                <span v-else class="text-[12.5px] text-ink-3">No report yet</span>
                <UiButton
                  v-if="(s.phase === 'ended' || s.phase === 'reporting') && (!a.report_status || a.report_status === 'draft')"
                  size="sm"
                  variant="ghost"
                  @click="(override = { shift: s, person: a }), (reason = ''), (minutes = 30)"
                >
                  Allow late submission
                </UiButton>
              </div>
            </li>
          </ul>
          <p v-else class="px-5 py-3 text-[13px] text-ink-3">No one assigned.</p>
        </article>
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
