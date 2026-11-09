<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { classifyWindow, ReportDraftContent, type ReportStatus } from '@sh/shared';
import ApprovedHandoverView from '@/components/ApprovedHandoverView.vue';
import ReportContentView from '@/components/ReportContentView.vue';
import ReportForm from '@/components/ReportForm.vue';
import ReportingWindow from '@/components/ReportingWindow.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { dateTime, day, shiftRange, time } from '@/lib/format';
import type { Decision, DeliveryRow, Revision, ShiftView, WindowStateValue } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useNow } from '@/lib/useNow';
import { useAuth } from '@/stores/auth';

interface ReportDetail {
  report: {
    id: string;
    reference_code: string;
    status: ReportStatus;
    draft_content: unknown;
    current_revision: number;
    last_submitted_at: string | null;
    is_late: boolean;
    updated_at: string;
    window_state: WindowStateValue;
  };
  shift: ShiftView;
  revisions: Revision[];
  decisions: Decision[];
  deliveries: DeliveryRow[];
  open_issues: { id: string; code: string; title: string; status: string }[];
}

const route = useRoute();
const auth = useAuth();
const now = useNow();
const id = computed(() => String(route.params.id));
const { data, loading, error, reload } = useAsync(() => api.get<ReportDetail>(`/reports/${id.value}`), [id]);

const status = computed(() => data.value?.report.status);
const liveWindow = computed(() => {
  const d = data.value;
  if (!d) return null;
  const s = d.report.window_state;
  if (['not_assigned', 'cancelled', 'not_found'].includes(s)) return s;
  return classifyWindow({ ...d.shift, override_expires_at: d.shift.override_expires_at }, now.value);
});
const editable = computed(() => {
  if (status.value === 'revision_requested') return true;
  return status.value === 'draft' && ['early_draft', 'open', 'override'].includes(liveWindow.value ?? '');
});
const canSubmit = computed(() => status.value === 'revision_requested' || ['open', 'override'].includes(liveWindow.value ?? ''));
const blockedReason = computed(() => {
  const s = data.value?.shift;
  if (!s || canSubmit.value) return null;
  if (liveWindow.value === 'early_draft') return `Final submission opens at ${time(s.window_opens_at, s.timezone)}`;
  return 'The reporting window is closed';
});

const latestDecision = computed(() => data.value?.decisions[0] ?? null);
const approved = computed(() => data.value?.decisions.find((d) => d.decision === 'approved') ?? null);
const latestRevision = computed(() => {
  const r = data.value?.revisions[0];
  return r ? { ...r, content: ReportDraftContent.parse(r.content) } : null;
});
const issueLabels = computed(() => Object.fromEntries((data.value?.open_issues ?? []).map((i) => [i.id, `${i.code} ${i.title}`])));

const head = computed(() => auth.terms.head);
const STATUS_COPY = computed<Record<ReportStatus, string>>(() => ({
  draft: 'Not submitted yet.',
  submitted: `Received. Mica will prepare it for your ${head.value}’s review.`,
  processing: `Mica is preparing it for your ${head.value}’s review.`,
  pending_review: `Waiting for your ${head.value} to verify it.`,
  revision_requested: `Your ${head.value} returned it for revision. Update the ${auth.terms.reportLower} below and submit again.`,
  approved: 'Verified and approved. It will be endorsed when the incoming shift is staffed.',
  rejected: `Your ${head.value} did not approve this ${auth.terms.reportLower}.`,
  delivered: 'Verified, approved and endorsed to the incoming shift.',
}));
const journey = computed(() => ['Write', `${auth.terms.supervisor} review`, 'Approved', 'Endorsed']);
const journeyIndex = computed(() => {
  const value = status.value;
  if (!value || value === 'draft' || value === 'revision_requested') return 0;
  if (['submitted', 'processing', 'pending_review', 'rejected'].includes(value)) return 1;
  if (value === 'approved') return 2;
  return 3;
});
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-3xl">
            <StateBlock :loading="loading" :error="error" :lines="6" @retry="reload()">
              <template v-if="data">
                <RouterLink to="/reports" class="mb-4 inline-block text-[13px] text-ink-3 hover:text-ink">← My {{ $terms.reportsLower }}</RouterLink>
                <PageHeader :eyebrow="data.report.reference_code" :title="`${data.shift.label} shift ${$terms.reportLower.replace(/^shift /, '')}`">
                  <template #meta>
                    <p class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2 tnum">
                      <span>{{ day(data.shift.starts_at, data.shift.timezone) }} · {{ shiftRange(data.shift) }}</span>
                      <StatusBadge :report="data.report.status" />
                      <span v-if="data.report.is_late" class="text-[13px] text-warn">Submitted late with the {{ $terms.head }}’s approval</span>
                    </p>
                  </template>
                </PageHeader>

                <div class="card -mt-2 mb-4 overflow-hidden" aria-label="Report progress">
                  <ol class="stagger grid grid-cols-2 sm:grid-cols-4">
                    <li
                      v-for="(step, index) in journey"
                      :key="step"
                      class="flex items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
                      :class="index === journeyIndex ? 'bg-accent-soft text-accent-ink' : index < journeyIndex ? 'text-ok' : 'text-ink-3'"
                    >
                      <span class="grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold" :class="index <= journeyIndex ? 'border-current' : 'border-line-strong'">{{ index < journeyIndex ? '✓' : index + 1 }}</span>
                      <span class="text-[11.5px] font-medium">{{ step }}</span>
                    </li>
                  </ol>
                </div>

                <p class="mb-6 text-[14px] text-ink-2">{{ STATUS_COPY[data.report.status] }}</p>

                <div v-if="latestDecision && latestDecision.decision !== 'approved'" class="mb-6 rounded-lg border px-4 py-3"
                  :class="latestDecision.decision === 'rejected' ? 'border-bad/25 bg-bad-soft' : 'border-violet/25 bg-violet-soft'">
                  <p class="text-[14px] font-medium" :class="latestDecision.decision === 'rejected' ? 'text-bad' : 'text-violet'">
                    {{ latestDecision.decision === 'rejected' ? 'Rejected' : 'Revision requested' }} by {{ latestDecision.reviewer_name }} · {{ dateTime(latestDecision.decided_at) }}
                  </p>
                  <p class="mt-1 text-[14px] whitespace-pre-wrap">{{ latestDecision.note }}</p>
                </div>

                <template v-if="editable">
                  <div v-if="data.report.status === 'draft'" class="card mb-6 p-4">
                    <ReportingWindow :shift="data.shift" :now="now" />
                  </div>
                  <ReportForm
                    :report-id="data.report.id"
                    :initial="data.report.draft_content"
                    :server-updated-at="data.report.updated_at"
                    :is-revision="data.report.status === 'revision_requested'"
                    :can-submit="canSubmit"
                    :submit-blocked-reason="blockedReason"
                    :open-issues="data.open_issues"
                    @submitted="reload()"
                  />
                </template>

                <template v-else>
                  <div v-if="data.report.status === 'draft'" class="card mb-6 p-4">
                    <ReportingWindow :shift="data.shift" :now="now" />
                  </div>

                  <section v-if="approved?.approved_content" class="card mb-6 p-5">
                    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                      <h2 class="text-[15px] font-semibold">Approved endorsement</h2>
                      <p class="text-[13px] text-ink-3">Verified by {{ approved.reviewer_name }} · {{ dateTime(approved.decided_at) }}</p>
                    </div>
                    <ApprovedHandoverView :content="approved.approved_content" />
                    <div v-if="data.deliveries.length" class="mt-5 border-t border-line pt-4">
                      <h3 class="eyebrow">Delivered to</h3>
                      <ul class="mt-2 space-y-1 text-[14px]">
                        <li v-for="d in data.deliveries" :key="d.id" class="flex justify-between gap-3">
                          <span>{{ d.recipient_name }}</span>
                          <span class="text-ink-3 tnum">{{ d.acknowledged_at ? `Acknowledged ${dateTime(d.acknowledged_at)}` : 'Not yet acknowledged' }}</span>
                        </li>
                      </ul>
                    </div>
                  </section>

                  <section v-if="latestRevision" class="card p-5">
                    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                      <h2 class="text-[15px] font-semibold">What you submitted</h2>
                      <p class="text-[13px] text-ink-3 tnum">Revision {{ latestRevision.revision_no }} · {{ dateTime(latestRevision.submitted_at) }}</p>
                    </div>
                    <ReportContentView :content="latestRevision.content" :issue-labels="issueLabels" />
                  </section>
                  <p v-else-if="data.report.status === 'draft'" class="text-[14px] text-ink-3">This draft was not submitted before the window closed.</p>
                </template>
              </template>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
