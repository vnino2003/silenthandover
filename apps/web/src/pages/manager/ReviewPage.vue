<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ISSUE_SEVERITIES,
  ReportDraftContent,
  VERIFICATION_STATUS_LABELS,
  type AiHandoverDraft,
  type ApprovedIssue,
  type FlagResolution,
  type ReportStatus,
  type VerificationStatus,
} from '@sh/shared';
import ApprovedHandoverView from '@/components/ApprovedHandoverView.vue';
import FlagList from '@/components/FlagList.vue';
import MicaMascot from '@/components/MicaMascot.vue';
import ReportContentView from '@/components/ReportContentView.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { dateTime, day, shiftRange, time } from '@/lib/format';
import type { AnalysisRun, Decision, DeliveryRow, Revision, ShiftView } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

interface ReviewData {
  report: { id: string; reference_code: string; status: ReportStatus; analysis_state: string; current_revision: number; last_submitted_at: string; is_late: boolean; employee_name: string; employee_pseudonym: string };
  shift: ShiftView;
  revisions: Revision[];
  runs: AnalysisRun[];
  decisions: Decision[];
  records: { id: string; record_type: string; reference_code: string; title: string; details: string; recorded_at: string }[];
  open_issues: { id: string; code: string; title: string; status: string; severity: string; is_safety: boolean }[];
  incoming_shifts: { id: string; label: string; starts_at: string; assignees: string[] }[];
  deliveries: DeliveryRow[];
  analysis_input: { sanitized_text: string; redaction_counts: Record<string, number>; injection_findings: { rule: string; excerpt: string }[]; expires_at: string } | null;
}

const route = useRoute();
const router = useRouter();
const toast = useToast();
const id = computed(() => String(route.params.id));
const { data, loading, error, reload } = useAsync(() => api.get<ReviewData>(`/manager/reports/${id.value}`), [id]);

// Poll while the draft is being prepared.
let poll: ReturnType<typeof setInterval> | null = null;
watch(
  () => data.value?.report.status,
  (s) => {
    if (poll) clearInterval(poll);
    poll = s === 'submitted' || s === 'processing' ? setInterval(() => void reload(true), 2500) : null;
  },
);
onUnmounted(() => poll && clearInterval(poll));

const revision = computed(() => {
  const r = data.value?.revisions[0];
  return r ? { ...r, content: ReportDraftContent.parse(r.content) } : null;
});
const currentRuns = computed(() => data.value?.runs.filter((r) => r.revision_no === data.value!.report.current_revision) ?? []);
const run = computed(() => currentRuns.value.find((r) => r.status === 'succeeded') ?? null);
const failedRuns = computed(() => currentRuns.value.filter((r) => r.status !== 'succeeded'));
const draft = computed<AiHandoverDraft | null>(() => run.value?.draft ?? null);
const issueLabels = computed(() => Object.fromEntries((data.value?.open_issues ?? []).map((i) => [i.id, `${i.code} ${i.title}`])));
const decided = computed(() => data.value?.decisions.find((d) => d.revision_no === data.value?.report.current_revision) ?? null);
const reviewing = computed(() => data.value?.report.status === 'pending_review');

// ---- Editable handover ------------------------------------------------------
interface Meta {
  evidence: string | null;
  verification: VerificationStatus | null;
  /** The draft proposed linking this to an existing issue; the reviewer must confirm. */
  suggestedCode?: string | null;
}
const summary = ref('');
const completed = ref<{ description: string; meta: Meta }[]>([]);
const issues = ref<(ApprovedIssue & { meta: Meta })[]>([]);
const pending = ref<{ description: string; meta: Meta }[]>([]);
const notesForIncoming = ref('');
const resolutions = ref<Record<number, { resolution: FlagResolution['resolution'] | ''; note: string }>>({});
const highlight = ref<string | null>(null);
const sourceTab = ref<'original' | 'sanitized'>('original');
let initializedFor = '';

watch(
  [data, run],
  () => {
    const d = data.value;
    if (!d || !reviewing.value) return;
    const key = `${d.report.id}:${d.report.current_revision}:${run.value?.id ?? 'none'}`;
    if (key === initializedFor) return;
    initializedFor = key;
    const dr = draft.value;
    const byCode = new Map(d.open_issues.map((i) => [i.code, i.id]));
    summary.value = (dr?.summary ?? '').replace(/^\[Simulated draft[^\]]*\]\s*/, '');
    completed.value = (dr?.completed_tasks ?? []).map((t) => ({ description: t.description, meta: { evidence: t.source_evidence, verification: t.verification_status } }));
    issues.value = (dr?.unresolved_issues ?? []).map((i) => ({
      title: i.title.slice(0, 160),
      description: i.description,
      severity: i.severity,
      is_safety_concern: i.is_safety_concern,
      link_issue_id: (i.related_issue_code && byCode.get(i.related_issue_code)) || null,
      initial_status: 'open',
      meta: { evidence: i.source_evidence, verification: i.verification_status, suggestedCode: i.related_issue_code },
    }));
    pending.value = (dr?.pending_actions ?? []).map((p) => ({ description: p.description, meta: { evidence: p.source_evidence, verification: p.verification_status } }));
    notesForIncoming.value = '';
    resolutions.value = Object.fromEntries((run.value?.flags ?? []).map((_f, i) => [i, { resolution: '', note: '' }]));
  },
  { immediate: true },
);

const flags = computed(() => run.value?.flags ?? []);
const unresolvedFlags = computed(() => flags.value.filter((_f, i) => !resolutions.value[i]?.resolution).length);
const canApprove = computed(() => summary.value.trim().length >= 10 && unresolvedFlags.value === 0 && issues.value.every((i) => i.title.trim().length >= 3));

function showEvidence(text: string | null) {
  if (!text) return;
  highlight.value = text;
  sourceTab.value = 'original';
  document.getElementById('source-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const blankMeta = (): Meta => ({ evidence: null, verification: null });
const addIssue = () =>
  issues.value.push({ title: '', description: '', severity: 'medium', is_safety_concern: false, link_issue_id: null, initial_status: 'open', meta: blankMeta() });

// ---- Decisions ---------------------------------------------------------------
const busy = ref(false);
const dialog = ref<'revision_requested' | 'rejected' | 'approve' | null>(null);
const decisionNote = ref('');
const approvalNote = ref('');

async function decide(decision: 'approved' | 'revision_requested' | 'rejected') {
  busy.value = true;
  try {
    const body =
      decision === 'approved'
        ? {
            decision,
            content: {
              summary: summary.value,
              completed_tasks: completed.value.filter((c) => c.description.trim()).map((c) => ({ description: c.description })),
              unresolved_issues: issues.value.map(({ meta: _m, ...i }) => i),
              pending_actions: pending.value.filter((p) => p.description.trim()).map((p) => ({ description: p.description })),
              notes_for_incoming: notesForIncoming.value,
            },
            flag_resolutions: Object.entries(resolutions.value).map(([i, r]) => ({ flag_index: Number(i), resolution: r.resolution, note: r.note })),
            note: approvalNote.value,
          }
        : { decision, note: decisionNote.value };
    const res = await api.post<{ status: ReportStatus; recipients: number }>(`/manager/reports/${id.value}/decision`, body);
    dialog.value = null;
    toast.ok(
      decision === 'approved'
        ? res.recipients
          ? `Approved and delivered to ${res.recipients} incoming ${res.recipients === 1 ? 'employee' : 'employees'}`
          : 'Approved. It will be delivered when the incoming shift is staffed.'
        : decision === 'rejected'
          ? 'Report rejected'
          : 'Revision requested',
    );
    await reload(true);
  } catch (err) {
    toast.error(err instanceof ApiError && Object.keys(err.fields).length ? `${err.message}: ${Object.values(err.fields)[0]}` : errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function reanalyze() {
  busy.value = true;
  try {
    await api.post(`/manager/reports/${id.value}/reanalyze`);
    initializedFor = '';
    toast.info('Mica is preparing the draft again');
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}

const VERIFY_TONE: Record<VerificationStatus, string> = {
  reported_unverified: 'text-ink-3',
  requires_verification: 'text-warn',
  supported_by_record: 'text-ok',
};
const redactionText = computed(() => {
  const c = data.value?.analysis_input?.redaction_counts;
  if (!c) return null;
  const labels: Record<string, string> = { employee_name: 'staff names', other_person: 'other names', email: 'emails', phone: 'phone numbers', government_id: 'government IDs', medical: 'medical terms' };
  const parts = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${labels[k] ?? k}`);
  return parts.length ? parts.join(', ') : 'nothing needed removing';
});
</script>

<template>
  <div>
    <RouterLink to="/manager" class="text-[13px] text-ink-3 hover:text-ink">← Review queue</RouterLink>
    <StateBlock class="mt-3" :loading="loading" :error="error" :lines="8" @retry="reload()">
      <template v-if="data && revision">
        <header class="mt-3 mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="eyebrow tnum">{{ data.report.reference_code }} · revision {{ data.report.current_revision }}</p>
            <h1 class="mt-1 text-[22px] font-semibold tracking-[-0.01em]">{{ data.report.employee_name }} — {{ data.shift.label }}</h1>
            <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2 tnum">
              <span>{{ day(data.shift.starts_at, data.shift.timezone) }} · {{ shiftRange(data.shift) }}</span>
              <span>Submitted {{ dateTime(data.report.last_submitted_at, data.shift.timezone) }}</span>
              <span v-if="data.report.is_late" class="text-warn">Late (override)</span>
              <StatusBadge :report="data.report.status" />
            </p>
          </div>
          <div v-if="reviewing" class="flex flex-wrap gap-2">
            <UiButton variant="ghost" size="sm" :loading="busy && !dialog" @click="reanalyze">Ask Mica again</UiButton>
            <UiButton variant="danger" size="sm" @click="(dialog = 'rejected'), (decisionNote = '')">Reject</UiButton>
            <UiButton size="sm" @click="(dialog = 'revision_requested'), (decisionNote = '')">Request revision</UiButton>
          </div>
        </header>

        <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <!-- Source: what the employee actually wrote -->
          <section id="source-panel" class="space-y-4 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto">
            <div class="card">
              <div class="flex items-center gap-1 border-b border-line px-3 pt-2" role="tablist">
                <button
                  v-for="t in [{ k: 'original', l: 'Original submission' }, { k: 'sanitized', l: 'Sent to Mica (sanitized)' }] as const"
                  :key="t.k"
                  role="tab"
                  :aria-selected="sourceTab === t.k"
                  class="-mb-px border-b-2 px-2.5 py-2 text-[13.5px]"
                  :class="sourceTab === t.k ? 'border-accent font-medium' : 'border-transparent text-ink-3 hover:text-ink'"
                  @click="sourceTab = t.k"
                >
                  {{ t.l }}
                </button>
              </div>
              <div class="px-5 py-4">
                <template v-if="sourceTab === 'original'">
                  <div v-if="highlight" class="mb-3 flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
                    <span>Highlighting evidence quoted by the draft.</span>
                    <button class="link" @click="highlight = null">Clear</button>
                  </div>
                  <ReportContentView :content="revision.content" :issue-labels="issueLabels" :highlight="highlight" />
                </template>
                <template v-else>
                  <template v-if="data.analysis_input">
                    <p class="mb-3 text-[12.5px] text-ink-3">
                      Exactly what Mica sent to the AI. Removed before sending: {{ redactionText }}. Kept until {{ day(data.analysis_input.expires_at) }}, then deleted.
                    </p>
                    <pre class="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2 font-sans">{{ data.analysis_input.sanitized_text }}</pre>
                  </template>
                  <p v-else class="text-[14px] text-ink-3">Not available — nothing has been sent for this revision, or the retention period has passed.</p>
                </template>
              </div>
            </div>

            <details class="card group" :open="data.records.length > 0 && data.records.length <= 4">
              <summary class="cursor-pointer list-none px-5 py-3 text-[14px] font-medium">
                Source records to check against <span class="font-normal text-ink-3">({{ data.records.length }})</span>
              </summary>
              <ul v-if="data.records.length" class="divide-y divide-line border-t border-line">
                <li v-for="r in data.records" :key="r.id" class="px-5 py-2.5 text-[13.5px]">
                  <p><span class="font-medium tnum">{{ r.reference_code }}</span> <span class="text-ink-3 capitalize">· {{ r.record_type }} · {{ dateTime(r.recorded_at) }}</span></p>
                  <p class="text-ink">{{ r.title }}</p>
                  <p v-if="r.details" class="text-ink-2">{{ r.details }}</p>
                </li>
              </ul>
              <p v-else class="border-t border-line px-5 py-3 text-[13px] text-ink-3">No supporting operational records near this shift. <RouterLink to="/manager/records" class="link">Add one</RouterLink></p>
            </details>
          </section>

          <!-- Draft: what will be delivered once verified -->
          <section class="min-w-0 space-y-5">
            <div v-if="data.report.status === 'submitted' || data.report.status === 'processing'" class="card px-5 py-8 text-center">
              <p class="flex items-center justify-center gap-2 text-[15px] font-medium"><MicaMascot :size="28" state="processing" animated />Mica is preparing the draft…</p>
              <p class="mt-1 text-[14px] text-ink-2">Mica is removing private details and checking the report. This page updates automatically.</p>
              <p v-if="failedRuns.length" class="mt-2 text-[13px] text-warn">{{ failedRuns.length }} earlier attempt(s) failed and will be retried.</p>
            </div>

            <template v-else-if="reviewing">
              <div v-if="run?.is_simulated" class="rounded-lg border border-warn/25 bg-warn-soft px-4 py-3 text-[13.5px] text-warn">
                <span class="font-medium">Mica practice draft.</span> No AI is connected, so Mica's built-in rules produced this draft. Verify it like any other draft.
              </div>
              <div v-else-if="run" class="flex flex-wrap gap-x-4 text-[12.5px] text-ink-3">
                <span class="flex items-center gap-1.5 font-medium text-ink-2"><MicaMascot :size="20" />Prepared by Mica</span><span>{{ run.model ?? run.engine }}</span><span>Prompt v{{ run.prompt_version }}</span><span v-if="run.latency_ms">{{ (run.latency_ms / 1000).toFixed(1) }}s</span>
              </div>
              <div v-else class="rounded-lg border border-bad/25 bg-bad-soft px-4 py-3 text-[13.5px] text-bad">
                <span class="font-medium">Mica couldn't prepare a draft.</span> It failed after {{ failedRuns.length }} attempt(s). Write the handover from the original submission, or ask Mica to try again.
              </div>

              <div v-if="flags.length" class="card p-5">
                <div class="mb-3 flex items-baseline justify-between gap-3">
                  <h2 class="text-[15px] font-semibold">Verification flags</h2>
                  <p class="text-[13px] tnum" :class="unresolvedFlags ? 'text-warn' : 'text-ok'">
                    {{ unresolvedFlags ? `${unresolvedFlags} of ${flags.length} need a decision` : 'All flags decided' }}
                  </p>
                </div>
                <FlagList :flags="flags" :resolutions="resolutions" @highlight="showEvidence" />
              </div>

              <div class="card space-y-6 p-5">
                <UiField v-slot="{ id: fid }" label="Summary for the incoming shift" hint="Plain, factual. Remove anything you could not verify or mark it as unverified.">
                  <textarea :id="fid" v-model="summary" class="field-input" rows="4" maxlength="2000" />
                </UiField>

                <div>
                  <div class="flex items-baseline justify-between">
                    <h3 class="text-[14px] font-medium">Unresolved issues</h3>
                    <button class="text-[13px] link" @click="addIssue">Add issue</button>
                  </div>
                  <p class="mt-0.5 text-[13px] text-ink-3">Each becomes a tracked problem, or updates one you link. Tasks below become the next shift’s checklist. Nothing is merged automatically.</p>
                  <ul class="mt-3 space-y-3">
                    <li v-for="(i, n) in issues" :key="n" class="rounded-md border border-line p-3.5">
                      <div class="grid gap-2 sm:grid-cols-[1fr_130px]">
                        <input v-model="i.title" class="field-input" maxlength="160" :aria-label="`Issue ${n + 1} title`" placeholder="Title" />
                        <select v-model="i.severity" class="field-input capitalize" :aria-label="`Issue ${n + 1} severity`">
                          <option v-for="s in ISSUE_SEVERITIES" :key="s" :value="s">{{ s }}</option>
                        </select>
                      </div>
                      <textarea v-model="i.description" class="field-input mt-2" rows="2" maxlength="1000" :aria-label="`Issue ${n + 1} description`" placeholder="Description" />
                      <div class="mt-2 grid gap-2 sm:grid-cols-2">
                        <select v-model="i.link_issue_id" class="field-input text-[13.5px]" :aria-label="`Issue ${n + 1} link`">
                          <option :value="null">New issue</option>
                          <option v-for="o in data.open_issues" :key="o.id" :value="o.id">Update {{ o.code }} — {{ o.title }}</option>
                        </select>
                        <select v-if="!i.link_issue_id" v-model="i.initial_status" class="field-input text-[13.5px]" :aria-label="`Issue ${n + 1} status`">
                          <option value="open">Open — confirmed problem</option>
                          <option value="pending_verification">Pending verification — not yet confirmed</option>
                        </select>
                      </div>
                      <p v-if="i.meta.suggestedCode && i.link_issue_id" class="mt-1.5 text-[12.5px] text-info">
                        The draft suggests this is {{ i.meta.suggestedCode }}. Confirm, or choose “New issue”.
                      </p>
                      <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
                        <label class="flex items-center gap-1.5"><input v-model="i.is_safety_concern" type="checkbox" class="size-3.5 accent-accent" /> Safety concern</label>
                        <span v-if="i.meta.verification" :class="VERIFY_TONE[i.meta.verification]">{{ VERIFICATION_STATUS_LABELS[i.meta.verification] }}</span>
                        <button v-if="i.meta.evidence" class="link" @click="showEvidence(i.meta.evidence)">Show evidence</button>
                        <button class="ml-auto text-ink-3 hover:text-bad" @click="issues.splice(n, 1)">Remove</button>
                      </div>
                    </li>
                  </ul>
                  <p v-if="!issues.length" class="mt-2 text-[13px] text-ink-3">No unresolved issues in this handover.</p>
                </div>

                <div v-for="list in [{ key: 'pending', title: 'Tasks for the next shift', items: pending }, { key: 'completed', title: 'Completed tasks', items: completed }] as const" :key="list.key">
                  <div class="flex items-baseline justify-between">
                    <h3 class="text-[14px] font-medium">{{ list.title }}</h3>
                    <button class="text-[13px] link" @click="list.items.push({ description: '', meta: blankMeta() })">Add</button>
                  </div>
                  <ul class="mt-2 space-y-2">
                    <li v-for="(item, n) in list.items" :key="n">
                      <div class="flex gap-2">
                        <input v-model="item.description" class="field-input" maxlength="500" :aria-label="`${list.title} ${n + 1}`" />
                        <button class="shrink-0 px-2 text-[13px] text-ink-3 hover:text-bad" :aria-label="`Remove ${list.title} ${n + 1}`" @click="list.items.splice(n, 1)">Remove</button>
                      </div>
                      <div v-if="item.meta.evidence || item.meta.verification" class="mt-1 flex gap-4 pl-1 text-[12.5px]">
                        <span v-if="item.meta.verification" :class="VERIFY_TONE[item.meta.verification]">{{ VERIFICATION_STATUS_LABELS[item.meta.verification] }}</span>
                        <button v-if="item.meta.evidence" class="link" @click="showEvidence(item.meta.evidence)">Show evidence</button>
                      </div>
                    </li>
                  </ul>
                  <p v-if="!list.items.length" class="mt-1 text-[13px] text-ink-3">None.</p>
                </div>

                <div v-if="draft?.missing_information.length" class="rounded-md bg-sunken px-4 py-3">
                  <h3 class="text-[13.5px] font-medium">Missing or unclear information</h3>
                  <ul class="mt-1.5 list-disc space-y-1 pl-5 text-[13.5px] text-ink-2">
                    <li v-for="(m, n) in draft.missing_information" :key="n"><span class="font-medium text-ink">{{ m.topic }}:</span> {{ m.detail }}</li>
                  </ul>
                  <p class="mt-2 text-[12.5px] text-ink-3">If it matters for the next shift, request a revision.</p>
                </div>

                <UiField v-slot="{ id: fid }" label="Notes for the incoming shift" optional>
                  <textarea :id="fid" v-model="notesForIncoming" class="field-input" rows="2" maxlength="2000" />
                </UiField>
              </div>

              <div class="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div class="text-[13.5px]">
                  <template v-if="data.incoming_shifts.length">
                    <p v-for="s in data.incoming_shifts" :key="s.id" class="text-ink-2">
                      Delivers to <span class="font-medium text-ink">{{ s.assignees.length ? s.assignees.join(', ') : 'no one yet' }}</span>
                      · {{ s.label }}, {{ time(s.starts_at, data.shift.timezone) }}
                    </p>
                  </template>
                  <p v-else class="text-warn">No incoming shift is scheduled yet — it will be delivered when one is staffed.</p>
                  <p v-if="unresolvedFlags" class="mt-0.5 text-warn">Decide every verification flag before approving.</p>
                </div>
                <UiButton variant="primary" size="lg" :disabled="!canApprove" @click="(dialog = 'approve'), (approvalNote = '')">Approve handover</UiButton>
              </div>
            </template>

            <template v-else-if="decided">
              <div class="card p-5">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 class="text-[15px] font-semibold capitalize">{{ decided.decision.replace('_', ' ') }}</h2>
                  <p class="text-[13px] text-ink-3">{{ decided.reviewer_name }} · {{ dateTime(decided.decided_at) }}</p>
                </div>
                <p v-if="decided.note" class="mt-2 text-[14px] whitespace-pre-wrap text-ink-2">{{ decided.note }}</p>
                <div v-if="decided.approved_content" class="mt-4 border-t border-line pt-4">
                  <ApprovedHandoverView :content="decided.approved_content" />
                </div>
              </div>
              <div v-if="run && decided.flag_resolutions?.length" class="card p-5">
                <h2 class="mb-3 text-[15px] font-semibold">Verification record</h2>
                <FlagList
                  :flags="run.flags"
                  readonly
                  :resolutions="Object.fromEntries(decided.flag_resolutions.map((r) => [r.flag_index, { resolution: r.resolution as FlagResolution['resolution'], note: r.note }]))"
                  @highlight="showEvidence"
                />
              </div>
              <div v-if="data.deliveries.length" class="card p-5">
                <h2 class="text-[15px] font-semibold">Delivery and acknowledgment</h2>
                <ul class="mt-3 divide-y divide-line text-[14px]">
                  <li v-for="d in data.deliveries" :key="d.id" class="flex justify-between gap-3 py-2">
                    <span>{{ d.recipient_name }}</span>
                    <span :class="d.acknowledged_at ? 'text-ok' : 'text-warn'" class="tnum">{{ d.acknowledged_at ? `Acknowledged ${dateTime(d.acknowledged_at)}` : 'Not yet acknowledged' }}</span>
                  </li>
                </ul>
              </div>
              <UiButton v-if="data.report.status === 'revision_requested'" variant="ghost" @click="router.push('/manager')">Back to queue</UiButton>
            </template>

            <details v-if="data.runs.length" class="text-[13px] text-ink-3">
              <summary class="cursor-pointer">Analysis history ({{ data.runs.length }} run{{ data.runs.length > 1 ? 's' : '' }})</summary>
              <ul class="mt-2 space-y-1 tnum">
                <li v-for="r in data.runs" :key="r.id">
                  {{ dateTime(r.created_at) }} · rev {{ r.revision_no }} · attempt {{ r.attempt }} · {{ r.engine }}<template v-if="r.is_simulated"> (simulated)</template> · v{{ r.prompt_version }} ·
                  <span :class="r.status === 'succeeded' ? 'text-ok' : 'text-bad'">{{ r.status.replace('_', ' ') }}</span>
                  <template v-if="r.validation_errors?.length"> — {{ r.validation_errors[0]!.path || 'output' }}: {{ r.validation_errors[0]!.message }}</template>
                </li>
              </ul>
            </details>
          </section>
        </div>
      </template>
    </StateBlock>

    <UiDialog
      :open="dialog === 'revision_requested' || dialog === 'rejected'"
      :title="dialog === 'rejected' ? 'Reject this report' : 'Request a revision'"
      :description="dialog === 'rejected' ? 'The report will not be delivered. The employee sees your reason.' : 'The employee can edit and resubmit. Tell them exactly what is missing.'"
      @close="dialog = null"
    >
      <UiField v-slot="{ id: fid }" label="Note to the employee">
        <textarea :id="fid" v-model="decisionNote" class="field-input" rows="4" maxlength="1000" />
      </UiField>
      <template #footer>
        <UiButton variant="ghost" @click="dialog = null">Cancel</UiButton>
        <UiButton :variant="dialog === 'rejected' ? 'danger' : 'primary'" :loading="busy" :disabled="decisionNote.trim().length < 5" @click="decide(dialog as 'revision_requested' | 'rejected')">
          {{ dialog === 'rejected' ? 'Reject report' : 'Send request' }}
        </UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="dialog === 'approve'" title="Approve and deliver?" @close="dialog = null">
      <p class="text-[14px] text-ink-2">
        You confirm you compared this handover with the original report and the source records. It is recorded with your name and delivered to the incoming shift.
      </p>
      <UiField v-slot="{ id: fid }" class="mt-4" label="Verification note" optional>
        <textarea :id="fid" v-model="approvalNote" class="field-input" rows="2" maxlength="1000" placeholder="e.g. Checked against MR-2291" />
      </UiField>
      <template #footer>
        <UiButton variant="ghost" @click="dialog = null">Cancel</UiButton>
        <UiButton variant="primary" :loading="busy" @click="decide('approved')">Approve and deliver</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
