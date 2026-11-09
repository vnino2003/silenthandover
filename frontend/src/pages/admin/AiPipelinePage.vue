<script setup lang="ts">
import { IonContent, IonItem, IonLabel, IonPage, IonSegment, IonSegmentButton, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, nextTick, ref, watch } from 'vue';
import { DepartmentExperience, type OrganizationRules, type ReportDraftContent } from '@sh/shared';
import MicaMascot from '@/components/MicaMascot.vue';
import MicaPromptsView from '@/components/MicaPromptsView.vue';
import OrganizationRulesEditor, { type RulesView } from '@/components/OrganizationRulesEditor.vue';
import PipelineSteps, { type PipelineView } from '@/components/PipelineSteps.vue';
import ReportForm from '@/components/ReportForm.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAsync } from '@/composables/useAsync';
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
const tab = ref<'real' | 'example' | 'mica' | 'rules'>('real');
const TABS = [
  { k: 'real', l: 'Real endorsements (censored)' },
  { k: 'example', l: 'Try an example' },
  { k: 'mica', l: 'Mica assistant prompts' },
  { k: 'rules', l: 'Organization rules' },
] as const;
// The rules in use, for the Mica prompts view (the editor loads its own copy and reports saves).
const rules = useAsync(() => api.get<RulesView>('/admin/ai/rules'));
const orgRules = computed<OrganizationRules | null>(() => rules.data.value?.current ?? null);
function rulesSaved(current: OrganizationRules) {
  if (rules.data.value) rules.data.value = { ...rules.data.value, current };
}

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
// The administrator belongs to no department: the example uses a chosen department's form and wording.
const departments = useAsync(() => api.get<{ id: string; name: string; experience: unknown }[]>('/admin/departments'));
const departmentId = ref<string | null>(null);
watch(() => departments.data.value, (rows) => { if (!departmentId.value && rows?.length) departmentId.value = rows[0]!.id; });
const exampleExperience = computed(() => {
  const d = departments.data.value?.find((x) => x.id === departmentId.value);
  return d ? DepartmentExperience.parse(d.experience ?? {}) : undefined;
});
const example = ref<PipelineView | null>(null);
const runs_ = ref(0);
const busy = ref(false);
const resultsEl = ref<HTMLElement | null>(null);
async function run(content: ReportDraftContent) {
  busy.value = true;
  try {
    example.value = await api.post<PipelineView>('/admin/ai/preview', { content, engine: engine.value, department_id: departmentId.value });
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
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-5xl">
            <PageHeader
              title="Mica's AI pipeline"
              description="What Mica does behind the scenes between a submitted shift endorsement and the draft the department head reviews: the template, the privacy redactions, the injection check, the prompt, the answer and the checks."
            />

            <section class="card mb-6 grid gap-5 p-5 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]" aria-labelledby="mica-about-h">
              <MicaMascot :size="56" state="attentive" />
              <div>
                <h2 id="mica-about-h" class="text-[15px] font-semibold">Mica is the AI of Silent Handover</h2>
                <p class="mt-1 text-[13px] leading-relaxed text-ink-2">One provider and one key, connected on <RouterLink to="/admin" class="link">Integrations</RouterLink>, power both of Mica's jobs:</p>
                <ul class="mt-2 space-y-1.5 text-[13px] text-ink-2">
                  <li><span class="font-medium text-ink">Cleaning shift endorsements.</span> Each submitted endorsement becomes the draft and flags a department head reviews. That is the trip shown below.</li>
                  <li><span class="font-medium text-ink">The assistant.</span> Staff prepare endorsements and leave dates; department heads and administrators ask about their pages.</li>
                </ul>
                <p class="mt-3 text-[12.5px] text-ink-3">{{ settings.data.value ? (providerReady ? `Connected: ${providerLabel}` : 'No AI connected: Mica uses its practice simulator for drafts and the page guide in the assistant.') : 'Checking the connection…' }}</p>
              </div>
              <div class="rounded-lg bg-canvas p-4 text-[12.5px] leading-relaxed text-ink-2">
                <p class="font-medium text-ink">The same safeguards everywhere</p>
                <ul class="mt-1.5 list-disc space-y-1 pl-4">
                  <li>Names become codes; health, contact and ID details are removed before anything is sent.</li>
                  <li>Six-part prompt; the user's words stay inside &lt;raw_input&gt; and never count as instructions. You can add <UiButton size="sm" variant="ghost" @click="tab = 'rules'">organization rules</UiButton> on top of the locked ones.</li>
                  <li>Every answer is checked. A failed or invented answer is never shown; work continues by hand.</li>
                  <li>Records shown in the assistant and leave reasons are never sent to the AI.</li>
                  <li>Mica never approves, submits or decides. People do.</li>
                </ul>
              </div>
            </section>

            <IonSegment :value="tab" scrollable class="sh-segment mb-5" aria-label="Pipeline views" @ion-change="tab = $event.detail.value as typeof tab">
              <IonSegmentButton v-for="t in TABS" :key="t.k" :value="t.k"><IonLabel>{{ t.l }}</IonLabel></IonSegmentButton>
            </IonSegment>

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
                  empty-title="No endorsements processed yet"
                  empty-text="When a staff member submits a shift endorsement, its trip through Mica appears here."
                  @retry="runs.reload()"
                >
                  <ul class="stagger card divide-y divide-line overflow-hidden">
                    <li v-for="r in runs.data.value" :key="r.id">
                      <IonItem button :detail="false" lines="none" class="sh-row"
                       
                        :class="selectedId === r.id ? 'bg-accent-soft' : 'hover:bg-canvas'"
                        :aria-current="selectedId === r.id ? 'true' : undefined"
                        @click="selectedId = r.id"
                      ><div class="w-full min-w-0 px-4 py-3 text-left">
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
                      </div></IonItem>
                    </li>
                  </ul>
                </StateBlock>
              </aside>
              <section class="min-w-0" aria-live="polite">
                <div v-if="detail" class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 class="text-[16px] font-semibold tnum">{{ detail.run.reference_code }} <span class="font-normal text-ink-3">· {{ detail.run.department_name }} · {{ detail.run.shift_label }}</span></h2>
                  <p class="text-[12.5px] text-ink-3">Revision {{ detail.run.revision_no }}, attempt {{ detail.run.attempt }}</p>
                </div>
                <StateBlock :loading="loadingDetail && !detail" :refreshing="loadingDetail && !!detail" :empty="!detail && !runs.loading.value" empty-title="Pick an endorsement on the left" :lines="7">
                  <PipelineSteps v-if="detail" :key="selectedId ?? ''" :view="detail" real />
                </StateBlock>
              </section>
            </div>

            <!-- Mica's assistant prompts -->
            <div v-else-if="tab === 'mica'" class="page-enter">
              <MicaPromptsView :organization="orgRules" />
            </div>

            <!-- Organization rules -->
            <div v-else-if="tab === 'rules'" class="page-enter">
              <OrganizationRulesEditor @saved="rulesSaved" />
            </div>

            <!-- Try an example -->
            <div v-else class="page-enter">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3">
                <p class="text-[13.5px] text-ink-2">
                  This is the <span class="font-medium text-ink">same form a staff member fills in</span> at the end of a shift. Fill it in (or press
                  <span class="font-medium">Generate example</span>), leave the optional boxes empty to see fallbacks, then run it.
                </p>
                <label v-if="(departments.data.value?.length ?? 0) > 1" class="flex items-center gap-2 text-[13px] text-ink-2">Department
                  <IonSelect v-model="departmentId" class="rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]" interface="popover">
                    <IonSelectOption v-for="d in departments.data.value" :key="d.id" :value="d.id">{{ d.name }}</IonSelectOption>
                  </IonSelect>
                </label>
                <IonSegment :value="engine" class="sh-segment" aria-label="Which AI answers" @ion-change="engine = $event.detail.value as typeof engine">
                  <IonSegmentButton value="simulator"><IonLabel>Practice simulator</IonLabel></IonSegmentButton>
                  <IonSegmentButton value="provider" :disabled="!providerReady" :title="providerReady ? '' : 'Connect an AI on the Integrations page first'"><IonLabel>{{ providerReady ? `Mica · ${providerLabel}` : 'Mica’s AI (not connected)' }}</IonLabel></IonSegmentButton>
                </IonSegment>
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
                :experience="exampleExperience"
                :preview-busy="busy"
                @preview="run"
              />
                    <div ref="resultsEl" class="scroll-mt-6">
                <PipelineSteps v-if="example" :key="runs_" class="mt-6" :view="example" />
              </div>
            </div>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
