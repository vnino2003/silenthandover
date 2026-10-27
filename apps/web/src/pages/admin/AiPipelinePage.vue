<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ReportDraftContent } from '@sh/shared';
import MicaMascot from '@/components/MicaMascot.vue';
import PipelineSteps, { type PipelineView } from '@/components/PipelineSteps.vue';
import ReportForm from '@/components/ReportForm.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * Mica's AI pipeline, step by step, for the administrator (IT). Mica is the system's one AI: the
 * same provider and key prepare the supervisor's report draft and answer in the Mica assistant.
 * - Real reports: what actually went to the AI for a submitted report — censored (names as
 *   codes, contact and health details removed) — and what came back. Never the original.
 * - Try an example: an example report runs through the same functions; nothing is saved.
 */
interface RunRow {
  id: string;
  reference_code: string;
  department_name: string;
  shift_label: string;
  revision_no: number;
  attempt: number;
  status: string;
  engine: string | null;
  model: string | null;
  is_simulated: boolean;
  created_at: string;
  flag_count: number;
}
type RunDetail = PipelineView & { run: { reference_code: string; department_name: string; shift_label: string; created_at: string; revision_no: number; attempt: number } };

const toast = useToast();
const tab = ref<'real' | 'example'>('real');

// ---- Real reports (censored)
const runs = useAsync(() => api.get<RunRow[]>('/admin/ai/runs'), [], { refreshMs: 30_000 });
const selectedId = ref<string | null>(null);
const detail = ref<RunDetail | null>(null);
const loadingDetail = ref(false);
watch(
  () => runs.data.value,
  (rows) => {
    if (!selectedId.value && rows?.length) selectedId.value = rows[0]!.id;
  },
);
watch(selectedId, async (id) => {
  if (!id) return;
  loadingDetail.value = true;
  try {
    detail.value = await api.get<RunDetail>(`/admin/ai/runs/${id}`);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    loadingDetail.value = false;
  }
});
const RUN_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info'> = { succeeded: 'ok', failed: 'bad', invalid_output: 'warn' };
const RUN_LABEL: Record<string, string> = { succeeded: 'Accepted', failed: 'AI unreachable', invalid_output: 'Rejected answer' };

// ---- Try an example
const settings = useAsync(() => api.get<{ provider: string; has_key: boolean; model: string | null; resolved_model: string | null; providers: Record<string, { label: string }> }>('/admin/ai'));
const providerReady = computed(() => !!settings.data.value && settings.data.value.provider !== 'simulator' && settings.data.value.has_key);
const providerLabel = computed(() => {
  const s = settings.data.value;
  if (!s || s.provider === 'simulator') return '';
  return `${s.providers[s.provider]?.label ?? s.provider} · ${s.model ?? s.resolved_model ?? 'newest model'}`;
});
const engine = ref<'simulator' | 'provider'>('simulator');
const example = ref<PipelineView | null>(null);
const runs_ = ref(0);
const busy = ref(false);
const resultsEl = ref<HTMLElement | null>(null);
async function run(content: ReportDraftContent) {
  busy.value = true;
  try {
    example.value = await api.post<PipelineView>('/admin/ai/preview', { content, engine: engine.value });
    runs_.value++;
    await nextTick();
    resultsEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader
      title="Mica's AI pipeline"
      description="What Mica does behind the scenes between a submitted report and the draft your supervisors review: the template, the privacy redactions, the injection check, the prompt, the answer and the checks."
    />

    <section class="card mb-6 grid gap-5 p-5 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]" aria-labelledby="mica-about-h">
      <MicaMascot :size="56" state="attentive" />
      <div>
        <h2 id="mica-about-h" class="text-[15px] font-semibold">Mica is the AI of Silent Handover</h2>
        <p class="mt-1 text-[13px] leading-relaxed text-ink-2">One provider and one key, connected on <RouterLink to="/admin" class="link">Integrations</RouterLink>, power both of Mica's jobs:</p>
        <ul class="mt-2 space-y-1.5 text-[13px] text-ink-2">
          <li><span class="font-medium text-ink">Cleaning reports.</span> Each submitted report becomes the draft and flags a supervisor reviews. That is the trip shown below.</li>
          <li><span class="font-medium text-ink">The assistant.</span> Employees prepare reports and leave dates; supervisors and administrators ask about their pages.</li>
        </ul>
        <p class="mt-3 text-[12.5px] text-ink-3">{{ settings.data.value ? (providerReady ? `Connected: ${providerLabel}` : 'No AI connected: Mica uses its practice simulator for drafts and the page guide in the assistant.') : 'Checking the connection…' }}</p>
      </div>
      <div class="rounded-lg bg-canvas p-4 text-[12.5px] leading-relaxed text-ink-2">
        <p class="font-medium text-ink">The same safeguards everywhere</p>
        <ul class="mt-1.5 list-disc space-y-1 pl-4">
          <li>Names become codes; health, contact and ID details are removed before anything is sent.</li>
          <li>Six-part prompt; the user's words stay inside &lt;raw_input&gt; and never count as instructions.</li>
          <li>Every answer is checked. A failed or invented answer is never shown; work continues by hand.</li>
          <li>Records shown in the assistant and leave reasons are never sent to the AI.</li>
          <li>Mica never approves, submits or decides. People do.</li>
        </ul>
      </div>
    </section>

    <div class="mb-5 flex gap-1 border-b border-line" role="tablist">
      <button
        v-for="t in [{ k: 'real', l: 'Real reports (censored)' }, { k: 'example', l: 'Try an example' }] as const"
        :key="t.k"
        role="tab"
        :aria-selected="tab === t.k"
        class="-mb-px border-b-2 px-3 py-2 text-[14px]"
        :class="tab === t.k ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-3 hover:text-ink'"
        @click="tab = t.k"
      >
        {{ t.l }}
      </button>
    </div>

    <!-- Real reports, censored -->
    <div v-if="tab === 'real'" class="page-enter grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside>
        <p class="mb-2 text-[12.5px] text-ink-3">
          Only the censored version that went to the AI is shown — never the original report or who wrote it.
        </p>
        <StateBlock
          :loading="runs.loading.value"
          :error="runs.error.value"
          :empty="!runs.data.value?.length"
          empty-title="No reports processed yet"
          empty-text="When an employee submits a report, its trip through Mica appears here."
          @retry="runs.reload()"
        >
          <ul class="stagger card divide-y divide-line overflow-hidden">
            <li v-for="r in runs.data.value" :key="r.id">
              <button
                type="button"
                class="w-full px-4 py-3 text-left"
                :class="selectedId === r.id ? 'bg-accent-soft' : 'hover:bg-canvas'"
                :aria-current="selectedId === r.id ? 'true' : undefined"
                @click="selectedId = r.id"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="text-[13.5px] font-medium tnum">{{ r.reference_code }}</span>
                  <StatusBadge :tone="RUN_TONE[r.status] ?? 'info'" :label="RUN_LABEL[r.status] ?? r.status" />
                </span>
                <span class="mt-0.5 block text-[12px] text-ink-3">
                  {{ r.department_name }} · {{ dateTime(r.created_at) }}<template v-if="r.attempt > 1"> · attempt {{ r.attempt }}</template>
                </span>
                <span class="block text-[12px] text-ink-3">
                  {{ r.is_simulated ? 'Mica practice simulator' : `Mica · ${r.engine ?? '—'}` }}<template v-if="r.flag_count"> · {{ r.flag_count }} flag{{ r.flag_count === 1 ? '' : 's' }}</template>
                </span>
              </button>
            </li>
          </ul>
        </StateBlock>
      </aside>
      <section class="min-w-0" aria-live="polite">
        <div v-if="detail" class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-[16px] font-semibold tnum">{{ detail.run.reference_code }} <span class="font-normal text-ink-3">· {{ detail.run.department_name }} · {{ detail.run.shift_label }}</span></h2>
          <p class="text-[12.5px] text-ink-3">Revision {{ detail.run.revision_no }}, attempt {{ detail.run.attempt }}</p>
        </div>
        <StateBlock :loading="loadingDetail && !detail" :refreshing="loadingDetail && !!detail" :empty="!detail && !runs.loading.value" empty-title="Pick a report on the left" :lines="7">
          <PipelineSteps v-if="detail" :key="selectedId ?? ''" :view="detail" real />
        </StateBlock>
      </section>
    </div>

    <!-- Try an example -->
    <div v-else class="page-enter">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <p class="text-[13.5px] text-ink-2">
          This is the <span class="font-medium text-ink">same form an employee fills in</span> at the end of a shift. Fill it in (or press
          <span class="font-medium">Generate example</span>), leave the optional boxes empty to see fallbacks, then run it.
        </p>
        <div class="flex rounded-md border border-line p-0.5 text-[13px]" role="radiogroup" aria-label="Which AI answers">
          <button type="button" role="radio" :aria-checked="engine === 'simulator'" class="rounded px-3 py-1.5" :class="engine === 'simulator' ? 'bg-sunken font-medium' : 'text-ink-3'" @click="engine = 'simulator'">Practice simulator</button>
          <button
            type="button"
            role="radio"
            :aria-checked="engine === 'provider'"
            :disabled="!providerReady"
            class="rounded px-3 py-1.5 disabled:opacity-50"
            :class="engine === 'provider' ? 'bg-sunken font-medium' : 'text-ink-3'"
            :title="providerReady ? '' : 'Connect an AI on the Integrations page first'"
            @click="engine = 'provider'"
          >
            {{ providerReady ? `Mica · ${providerLabel}` : 'Mica’s AI (not connected)' }}
          </button>
        </div>
      </div>
      <ReportForm
        report-id="pipeline-example"
        :initial="null"
        server-updated-at=""
        :is-revision="false"
        :can-submit="true"
        :submit-blocked-reason="null"
        :open-issues="[]"
        preview
        :preview-busy="busy"
        @preview="run"
      />
            <div ref="resultsEl" class="scroll-mt-6">
        <PipelineSteps v-if="example" :key="runs_" class="mt-6" :view="example" />
      </div>
    </div>
  </div>
</template>
