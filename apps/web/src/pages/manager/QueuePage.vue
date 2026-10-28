<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import type { ReportStatus } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { day, relative } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';

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
  flag_count: number | null;
  is_simulated: boolean | null;
  has_safety: boolean | null;
}
interface Summary {
  pending_review: number;
  processing: number;
  awaiting_verification: number;
  open_safety: number;
  open_issues: number;
}

const auth = useAuth();
const router = useRouter();
// Supervisors keep this open while reports come in, so it refreshes itself.
const queue = useAsync(() => api.get<Row[]>('/manager/queue'), [], { refreshMs: 20_000 });
const summary = useAsync(() => api.get<Summary>('/manager/summary'), [], { refreshMs: 20_000 });
let t: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  t = setInterval(() => {
    void queue.reload(true);
    void summary.reload(true);
  }, 15_000);
});
onUnmounted(() => t && clearInterval(t));

const review = computed(() => queue.data.value?.filter((r) => r.status === 'pending_review') ?? []);
const inFlight = computed(() => queue.data.value?.filter((r) => r.status !== 'pending_review') ?? []);
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader :eyebrow="auth.profile?.department_name ?? ''" title="Review queue" description="Nothing reaches the incoming shift until you verify and approve it." />

    <div v-if="summary.data.value" class="stagger mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
      <div class="bg-surface px-4 py-3"><p class="text-[12.5px] text-ink-3">Awaiting your review</p><p class="text-[20px] font-semibold tnum">{{ summary.data.value.pending_review }}</p></div>
      <div class="bg-surface px-4 py-3"><p class="text-[12.5px] text-ink-3">Being prepared</p><p class="text-[20px] font-semibold tnum">{{ summary.data.value.processing }}</p></div>
      <RouterLink to="/manager/issues" class="bg-surface px-4 py-3 hover:bg-canvas"><p class="text-[12.5px] text-ink-3">Resolutions to verify</p><p class="text-[20px] font-semibold tnum">{{ summary.data.value.awaiting_verification }}</p></RouterLink>
      <RouterLink to="/manager/issues" class="bg-surface px-4 py-3 hover:bg-canvas">
        <p class="text-[12.5px] text-ink-3">Open safety {{ auth.terms.issues.toLowerCase() }}</p>
        <p class="text-[20px] font-semibold tnum" :class="summary.data.value.open_safety ? 'text-bad' : ''">{{ summary.data.value.open_safety }}</p>
      </RouterLink>
    </div>

    <StateBlock :loading="queue.loading.value" :error="queue.error.value" @retry="queue.reload()">
      <section>
        <h2 class="mb-2 text-[15px] font-semibold">Ready for review</h2>
        <StateBlock :empty="!review.length" empty-title="Nothing waiting for review" empty-text="New reports appear here once their draft is ready.">
          <ul class="stagger card divide-y divide-line">
            <li v-for="r in review" :key="r.id">
              <button class="grid w-full gap-1 px-5 py-3.5 text-left hover:bg-canvas sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4" @click="router.push(`/manager/reports/${r.id}`)">
                <div class="min-w-0">
                  <p class="text-[14px] font-medium">{{ r.employee_name }} <span class="font-normal text-ink-3">· {{ r.label }}, {{ day(r.shift_date) }}</span></p>
                  <p class="text-[13px] text-ink-3 tnum">
                    {{ r.reference_code }} · submitted {{ relative(r.last_submitted_at) }}<template v-if="r.current_revision > 1"> · revision {{ r.current_revision }}</template><template v-if="r.is_late"> · late</template>
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span v-if="r.has_safety" class="rounded-sm bg-bad px-1.5 py-px text-[11px] font-semibold tracking-wide text-white uppercase">Safety</span>
                  <span v-if="r.analysis_state === 'failed'" class="text-[12.5px] font-medium text-bad">No Mica draft — review original</span>
                  <span v-else-if="r.flag_count" class="text-[12.5px] font-medium text-warn tnum">{{ r.flag_count }} flag{{ r.flag_count > 1 ? 's' : '' }}</span>
                  <span v-if="r.is_simulated" class="text-[12.5px] text-ink-3">Mica practice draft</span>
                  <StatusBadge :report="r.status" />
                </div>
              </button>
            </li>
          </ul>
        </StateBlock>
      </section>

      <section v-if="inFlight.length" class="mt-8">
        <h2 class="mb-2 text-[15px] font-semibold">In progress</h2>
        <ul class="stagger card divide-y divide-line">
          <li v-for="r in inFlight" :key="r.id">
            <RouterLink :to="`/manager/reports/${r.id}`" class="flex items-center justify-between gap-3 px-5 py-3 hover:bg-canvas">
              <span class="min-w-0 text-[14px]">
                {{ r.employee_name }} <span class="text-ink-3">· {{ r.label }} · {{ r.reference_code }}</span>
              </span>
              <StatusBadge :report="r.status" />
            </RouterLink>
          </li>
        </ul>
      </section>
    </StateBlock>
  </div>
</template>
