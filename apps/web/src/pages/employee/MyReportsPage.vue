<script setup lang="ts">
import { computed, ref } from 'vue';
import { REPORT_STATUS_LABELS, type ReportStatus } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { dateTime, day } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';

interface Row {
  id: string;
  reference_code: string;
  status: ReportStatus;
  current_revision: number;
  last_submitted_at: string | null;
  is_late: boolean;
  label: string;
  shift_date: string;
  starts_at: string;
  latest_note: string | null;
  decided_at: string | null;
}

const { data, loading, error, reload } = useAsync(() => api.get<Row[]>('/reports/mine'));
const filter = ref<ReportStatus | 'all'>('all');
const rows = computed(() => (data.value ?? []).filter((r) => filter.value === 'all' || r.status === filter.value));
const present = computed(() => [...new Set((data.value ?? []).map((r) => r.status))]);
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <PageHeader title="My reports" description="Every report you have written, with its review status and supervisor feedback." />
    <div v-if="present.length > 1" class="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
      <button
        v-for="s in ['all', ...present] as const"
        :key="s"
        class="rounded-full border px-3 py-1 text-[13px]"
        :class="filter === s ? 'border-ink bg-ink text-white' : 'border-line-strong text-ink-2 hover:bg-sunken'"
        @click="filter = s"
      >
        {{ s === 'all' ? 'All' : REPORT_STATUS_LABELS[s] }}
      </button>
    </div>
    <StateBlock :loading="loading" :error="error" :empty="!rows.length" empty-title="No reports yet" empty-text="Reports you start from the Today page appear here." @retry="reload()">
      <ul class="card divide-y divide-line">
        <li v-for="r in rows" :key="r.id">
          <RouterLink :to="`/reports/${r.id}`" class="grid gap-1 px-5 py-3.5 hover:bg-canvas sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
            <div class="min-w-0">
              <p class="flex items-center gap-2 text-[14px] font-medium">
                <span class="tnum">{{ r.reference_code }}</span>
                <span class="font-normal text-ink-3">·</span>
                <span class="truncate">{{ r.label }}, {{ day(r.shift_date) }}</span>
              </p>
              <p class="text-[13px] text-ink-3 tnum">
                <template v-if="r.last_submitted_at">Submitted {{ dateTime(r.last_submitted_at) }}</template><template v-else>Draft</template>
                <template v-if="r.current_revision > 1"> · revision {{ r.current_revision }}</template>
                <template v-if="r.is_late"> · late</template>
              </p>
              <p v-if="r.latest_note && ['revision_requested', 'rejected'].includes(r.status)" class="mt-1 truncate text-[13px] text-ink-2">“{{ r.latest_note }}”</p>
            </div>
            <StatusBadge :report="r.status" class="justify-self-start sm:justify-self-end" />
          </RouterLink>
        </li>
      </ul>
    </StateBlock>
  </div>
</template>
