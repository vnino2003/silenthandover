<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { REPORT_STATUS_LABELS, REPORT_STATUSES, type ReportStatus } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { dateTime, day } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

const router = useRouter();

interface Row {
  id: string;
  reference_code: string;
  status: ReportStatus;
  analysis_state: string;
  current_revision: number;
  last_submitted_at: string;
  is_late: boolean;
  label: string;
  shift_date: string;
  employee_name: string;
}

const status = ref<ReportStatus | ''>('');
const days = ref(14);
const { data, loading, refreshing, error, reload } = useAsync(
  () => api.get<Row[]>(`/manager/reports?days=${days.value}${status.value ? `&status=${status.value}` : ''}`),
  [status, days],
);
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader title="Report history" description="Submitted reports in your department, with their review outcome.">
      <select v-model="status" class="field-input h-9 w-44 py-0 text-[14px]" aria-label="Status">
        <option value="">All statuses</option>
        <option v-for="s in REPORT_STATUSES.filter((x) => x !== 'draft')" :key="s" :value="s">{{ REPORT_STATUS_LABELS[s] }}</option>
      </select>
      <select v-model.number="days" class="field-input h-9 w-36 py-0 text-[14px]" aria-label="Period">
        <option :value="7">Last 7 days</option>
        <option :value="14">Last 14 days</option>
        <option :value="30">Last 30 days</option>
        <option :value="90">Last 90 days</option>
      </select>
    </PageHeader>
    <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :empty="!data?.length" empty-title="No reports in this period" @retry="reload()">
      <div class="card overflow-x-auto">
        <table class="w-full min-w-[620px] text-left text-[14px]">
          <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
            <tr><th class="px-5 py-2.5 font-medium">Report</th><th class="px-3 py-2.5 font-medium">Employee</th><th class="px-3 py-2.5 font-medium">Shift</th><th class="px-3 py-2.5 font-medium">Submitted</th><th class="px-5 py-2.5 text-right font-medium">Status</th></tr>
          </thead>
          <tbody class="stagger divide-y divide-line">
            <tr v-for="r in data" :key="r.id" class="cursor-pointer transition-colors hover:bg-canvas" @click="router.push(`/manager/reports/${r.id}`)">
              <td class="px-5 py-3"><RouterLink :to="`/manager/reports/${r.id}`" class="font-medium tnum hover:underline" @click.stop>{{ r.reference_code }}</RouterLink></td>
              <td class="px-3 py-3">{{ r.employee_name }}</td>
              <td class="px-3 py-3 text-ink-2">{{ r.label }}, {{ day(r.shift_date) }}</td>
              <td class="px-3 py-3 text-ink-3 tnum">{{ dateTime(r.last_submitted_at) }}<template v-if="r.is_late"> · late</template></td>
              <td class="px-5 py-3 text-right"><StatusBadge :report="r.status" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </div>
</template>
