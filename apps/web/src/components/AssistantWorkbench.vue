<script setup lang="ts">
import { computed, onMounted, ref, watch, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AssistantState, assistantMissing, REPORT_SECTIONS, type AssistantView, type IssueStatus, type ReportStatus, type AssistantContext } from '@sh/shared';
import MicaMascot from './MicaMascot.vue';
import { useAuth } from '@/stores/auth';
import { PROBLEM_CATEGORY_LABELS } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import NavIcon from '@/components/ui/NavIcon.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ReportContentView from '@/components/ReportContentView.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, shiftRange } from '@/lib/format';
import { useDictation } from '@/lib/useDictation';
import type { ShiftView } from '@/lib/types';

const props = withDefaults(defineProps<{ compact?: boolean; active?: boolean; context?: AssistantContext }>(), { active: true });
const auth = useAuth();
const fieldPrefix = useId();
const route = useRoute();
const router = useRouter();
const preparation = ref<AssistantView | null>(null);
const draft = ref(AssistantState.parse({}));
const message = ref('');
const busy = ref(false);
const error = ref('');
const confirming = ref(false);
const shifts = ref<ShiftView[]>([]);
const shiftId = ref('');
const language = ref('en-PH');
const messages = ref<{ who: 'you' | 'assistant'; text: string }[]>([]);
const dictation = useDictation((text) => { message.value = [message.value.trim(), text].filter(Boolean).join(' ').slice(0, 6000); });
watch(() => props.active, (active) => { if (!active) dictation.stop(); });
interface Status {
  reports: { id: string; reference_code: string; status: ReportStatus }[];
  issues: { id: string; code: string; title: string; status: IssueStatus }[];
  checked_at: string;
}
const status = ref<Status | null>(null);
const selectableShifts = computed(() => shifts.value.filter((s) => !s.report_status || ['draft', 'revision_requested'].includes(s.report_status)));
const missing = computed(() => {
  const list = assistantMissing(draft.value);
  if (draft.value.intent === 'report' && !preparation.value?.shift_id) list.push('Start a new conversation and select an assigned shift');
  return list;
});
const receiptPath = computed(() => preparation.value?.result ? `${preparation.value.result.kind === 'report' ? '/reports' : '/tasks'}/${preparation.value.result.id}` : '/reports');
const intentLabel = computed(() => ({ report: auth.experience.report_label, incident: 'Incident report', assistance: 'Assistance request', task_update: 'Task update', status: 'Workplace status', unsupported: 'Choose a task' })[draft.value.intent]);

function accept(p: AssistantView) {
  preparation.value = p;
  draft.value = structuredClone(p.state);
  shiftId.value = p.shift_id ?? '';
}
async function refreshStatus() {
  try { status.value = await api.get<Status>('/assistant/status'); }
  catch (e) { error.value = errorMessage(e); }
}
async function reload() {
  if (!preparation.value && (props.compact || !route.query.preparation)) return;
  busy.value = true; error.value = '';
  try {
    accept(await api.get<AssistantView>(`/assistant/preparations/${preparation.value?.id ?? route.query.preparation}`));
    messages.value = [{ who: 'assistant', text: preparation.value!.reply }];
    if (draft.value.intent === 'status') await refreshStatus();
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
onMounted(async () => {
  try {
    shifts.value = await api.get<ShiftView[]>('/employee/shifts');
    shiftId.value = typeof route.query.shift === 'string' ? route.query.shift : selectableShifts.value.find((s) => ['open', 'override', 'early_draft'].includes(s.window_state ?? ''))?.id ?? '';
  } catch (e) { error.value = errorMessage(e); }
  if (!props.compact && route.query.preparation) await reload();
});
async function send(text = message.value) {
  if (busy.value || !text.trim() || preparation.value?.result) return;
  dictation.stop(); busy.value = true; error.value = '';
  try {
    // Carry edits from the summary into the conversation rather than losing them on the next reply.
    if (preparation.value && JSON.stringify(draft.value) !== JSON.stringify(preparation.value.state)) {
      accept(await api.put<AssistantView>(`/assistant/preparations/${preparation.value.id}`, { version: preparation.value.version, state: draft.value }));
    }
    const p = await api.post<AssistantView>('/assistant/message', {
      message: text,
      context: props.context,
      ...(preparation.value ? { preparation_id: preparation.value.id, version: preparation.value.version } : { shift_id: shiftId.value || null }),
    });
    accept(p);
    messages.value.push({ who: 'you', text }, { who: 'assistant', text: p.reply });
    message.value = '';
    if (!props.compact) await router.replace({ path: '/assistant', query: { preparation: p.id } });
    if (p.state.intent === 'status') await refreshStatus();
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
async function review() {
  if (!preparation.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const p = await api.put<AssistantView>(`/assistant/preparations/${preparation.value.id}`, { version: preparation.value.version, state: draft.value });
    accept(p);
    if (p.ready) confirming.value = true;
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
async function confirm() {
  if (!preparation.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    accept(await api.post<AssistantView>(`/assistant/preparations/${preparation.value.id}/confirm`, { version: preparation.value.version, confirmed: true }));
    confirming.value = false;
  } catch (e) { error.value = errorMessage(e); confirming.value = false; }
  finally { busy.value = false; }
}
function reset() {
  dictation.stop(); preparation.value = null; messages.value = []; status.value = null;
  draft.value = AssistantState.parse({}); message.value = ''; error.value = '';
  if (!props.compact) void router.replace('/assistant');
}
function clearProblems() {
  if (draft.value.content.no_unresolved_issues) { draft.value.content.problems = []; draft.value.content.unresolved_issues = ''; }
}
</script>

<template>
  <div class="mx-auto max-w-5xl" :class="{ 'assistant-compact': compact }">
    <PageHeader v-if="!compact" title="Mica, your workplace assistant" eyebrow="A little less paperwork" description="Prepare a handover here, or open Mica from any page to keep working where you are.">
      <UiButton v-if="preparation" :disabled="busy" @click="reset">New conversation</UiButton>
    </PageHeader>
    <UiButton v-if="compact && preparation" size="sm" class="mb-3" :disabled="busy" @click="reset">New preparation</UiButton>

    <div class="grid items-start gap-5" :class="!compact && 'xl:grid-cols-[minmax(0,1fr)_300px]'">
      <section class="min-w-0 space-y-4" aria-label="Assistant conversation">
        <div v-if="!preparation" class="assistant-hero rounded-lg border border-accent/15 p-5 sm:p-7">
          <MicaMascot :size="compact ? 48 : 64" />
          <h2 class="mt-2 text-[20px] font-semibold tracking-tight">Let’s make the handover easier.</h2>
          <p class="mt-2 max-w-md text-[13px] leading-relaxed text-ink-2">Describe your work or choose a starting point. I’ll prepare the details for you to review.</p>
          <div class="mt-5 grid gap-2 sm:grid-cols-2">
            <button v-for="item in [{ title: 'Prepare my shift report', text: 'I want to submit my daily shift report', icon: '/reports' }, { title: 'Record an incident', text: 'I want to report an incident', icon: '/tasks' }, { title: 'Request assistance', text: 'I need assistance from my supervisor', icon: '/assistant' }, { title: 'Check my status', text: 'Check the status of my reports and issues', icon: '/handover' }]" :key="item.title" :disabled="busy" class="flex items-center gap-3 rounded-md border border-line bg-surface/90 px-4 py-3 text-left text-[13px] font-medium hover:border-accent disabled:opacity-50" @click="send(item.text)">
              <NavIcon :path="item.icon" />{{ item.title }}<span class="ml-auto text-ink-3" aria-hidden="true">↗</span>
            </button>
          </div>
        </div>

        <div class="card p-4">
          <label :for="`${fieldPrefix}-shift`" class="block text-[13px] font-medium">Reporting shift <span class="font-normal text-ink-3">· required for shift reports</span></label>
          <select :id="`${fieldPrefix}-shift`" v-model="shiftId" class="field-input mt-2" :disabled="Boolean(preparation) || busy">
            <option value="">Select an assigned shift</option>
            <option v-for="s in selectableShifts" :key="s.id" :value="s.id">{{ s.label }} · {{ dateTime(s.starts_at) }} · {{ shiftRange(s) }}</option>
          </select>
          <p class="mt-2 text-[12px] text-ink-3">{{ preparation ? 'To change shift, start a new conversation.' : 'You can report incidents or request help without an active shift.' }}</p>
        </div>

        <div v-if="preparation" class="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span class="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent-ink">{{ preparation.engine === 'guided' ? 'Guided mode · no AI connected' : `${preparation.engine} · AI assisted` }}</span>
          <span>Preparation expires {{ dateTime(preparation.expires_at) }}</span>
        </div>
        <div v-if="messages.length" role="log" aria-label="Conversation" aria-live="polite" class="space-y-4">
          <div v-for="(m, index) in messages" :key="index" class="flex" :class="m.who === 'you' ? 'justify-end' : ''">
            <div class="max-w-[95%] rounded-lg px-4 py-3 text-[14px] whitespace-pre-wrap" :class="m.who === 'you' ? 'bg-accent text-white' : 'border border-line bg-surface'">
              <p class="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wider uppercase opacity-70"><MicaMascot v-if="m.who === 'assistant'" :size="22" />{{ m.who === 'you' ? 'You' : 'Mica' }}</p>{{ m.text }}
            </div>
          </div>
        </div>
        <p v-if="busy" role="status" class="flex items-center gap-2 text-[13px] text-ink-3"><MicaMascot :size="28" thinking />Preparing your request…</p>
        <div v-if="error" class="rounded-lg border border-bad/25 bg-bad-soft p-4 text-[14px] text-bad" role="alert">
          {{ error }}
          <button v-if="preparation" class="mt-2 block underline" :disabled="busy" @click="reload">Reload preparation</button>
        </div>

        <div v-if="preparation?.result" class="card border-ok/30 bg-ok-soft p-5" role="status">
          <h2 class="font-semibold text-ok">Request recorded</h2>
          <p class="mt-1 text-[14px]">{{ preparation.result.reference }} · {{ preparation.result.status?.replaceAll('_', ' ') }}</p>
          <p class="mt-2 text-[13px] text-ink-2">{{ preparation.result.kind === 'report' ? 'Your supervisor will review it before the next shift receives it.' : 'Your update is saved. Completion claims still need supervisor verification.' }}</p>
          <UiButton class="mt-4" :to="receiptPath">View record and status</UiButton>
        </div>
        <form v-else class="assistant-composer card p-3 sm:p-4" @submit.prevent="send()">
          <label :for="`${fieldPrefix}-message`" class="sr-only">Message to workplace assistant</label>
          <textarea :id="`${fieldPrefix}-message`" v-model="message" class="field-input min-h-24 border-transparent bg-transparent shadow-none" rows="3" maxlength="6000" :disabled="busy || dictation.listening.value" placeholder="Tell me what you need help with…" />
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <div class="flex items-center gap-2">
              <UiButton size="sm" :disabled="busy || !dictation.supported" :aria-pressed="dictation.listening.value" @click="dictation.listening.value ? dictation.stop() : dictation.start(language)">{{ dictation.listening.value ? 'Stop listening' : 'Use voice' }}</UiButton>
              <select v-model="language" class="max-w-24 rounded-md border border-line bg-surface p-1.5 text-[12px]" aria-label="Voice language" :disabled="dictation.listening.value"><option value="en-PH">English</option><option value="fil-PH">Filipino</option></select>
            </div>
            <UiButton type="submit" variant="primary" :loading="busy" :disabled="!message.trim() || dictation.listening.value">Send message</UiButton>
          </div>
          <p class="mt-2 text-[11px] text-ink-3">{{ dictation.listening.value ? 'Listening… Your transcript will appear here for you to edit.' : dictation.supported ? 'Voice creates an editable transcript. Your browser may process audio through its speech service.' : 'Voice is unavailable in this browser. You can type every request.' }}</p>
          <p v-if="dictation.error.value" role="alert" class="mt-2 text-[12px] text-bad">{{ dictation.error.value }}</p>
        </form>

        <section v-if="status" class="card p-5" aria-label="Current status">
          <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold">Your latest records</h2><UiButton size="sm" @click="refreshStatus">Refresh status</UiButton></div>
          <p class="mt-1 text-[12px] text-ink-3">Checked {{ dateTime(status.checked_at) }}</p>
          <p v-if="!status.reports.length && !status.issues.length" class="mt-4 text-[14px] text-ink-3">No reports or department issues yet.</p>
          <ul class="mt-3 divide-y divide-line">
            <li v-for="r in status.reports" :key="r.id" class="flex flex-wrap items-center justify-between gap-2 py-3"><RouterLink :to="`/reports/${r.id}`" class="link text-[14px]">{{ r.reference_code }}</RouterLink><StatusBadge :report="r.status" /></li>
            <li v-for="i in status.issues" :key="i.id" class="flex flex-wrap items-center justify-between gap-2 py-3"><RouterLink :to="`/tasks/${i.id}`" class="link text-[14px]">{{ i.code }} · {{ i.title }}</RouterLink><StatusBadge :issue="i.status" /></li>
          </ul>
        </section>
      </section>

      <aside class="min-w-0 space-y-4">
        <component :is="compact ? 'details' : 'section'" v-if="preparation && !preparation.result && !['status', 'unsupported'].includes(draft.intent)" class="card p-5" aria-label="Prepared action">
          <summary v-if="compact" class="cursor-pointer text-[13px] font-medium">{{ intentLabel }} <span class="mt-1 block text-[11px] font-normal text-ink-3">{{ missing.length ? 'Answers still needed · expand to edit' : 'Prepared · expand to review or edit' }}</span></summary>
          <p class="eyebrow">Your preparation</p><h2 class="mt-1 text-[18px] font-semibold">{{ intentLabel }}</h2>
          <p class="mt-2 text-[12px] text-ink-3">Check every detail. You can edit the fields below before sending.</p>
          <fieldset :disabled="busy" class="mt-4 space-y-4">
            <template v-if="draft.intent === 'report'">
              <label v-for="s in REPORT_SECTIONS" :key="s.key" class="block text-[13px] font-medium">{{ s.label }}<textarea v-model="draft.content[s.key]" class="field-input mt-1" rows="3" :maxlength="s.key === 'handover_notes' || s.key === 'operational_concerns' ? 3000 : 4000" :disabled="(s.key === 'unresolved_issues' && draft.content.no_unresolved_issues) || (s.key === 'pending_tasks' && draft.content.no_pending_tasks)" /></label>
              <div v-for="(p, index) in draft.content.problems" :key="index" class="rounded-md border border-line p-3">
                <label class="block text-[12px]">Problem · {{ PROBLEM_CATEGORY_LABELS[p.category] }}<textarea v-model="p.what" class="field-input mt-1" maxlength="600" rows="2" /></label>
                <label class="mt-2 block text-[12px]">Location<input v-model="p.location" class="field-input mt-1" maxlength="120" /></label>
                <button class="mt-2 text-[12px] text-bad" @click="draft.content.problems.splice(index, 1)">Remove problem</button>
              </div>
              <label class="flex items-start gap-2 text-[13px]"><input v-model="draft.content.no_unresolved_issues" type="checkbox" class="mt-1 size-4 shrink-0 accent-accent" @change="clearProblems" />I confirm there are no open problems</label>
              <label class="flex items-start gap-2 text-[13px]"><input v-model="draft.content.no_pending_tasks" type="checkbox" class="mt-1 size-4 shrink-0 accent-accent" @change="draft.content.no_pending_tasks && (draft.content.pending_tasks = '')" />Nothing for the next shift</label>
              <label class="block text-[13px]">Evidence references<input v-model="draft.content.evidence_refs" class="field-input mt-1" maxlength="500" /></label>
              <div v-for="u in draft.content.issue_updates" :key="u.issue_id" class="rounded-md border border-line p-3 text-[12px]">Existing issue update · {{ u.claimed_status }}<textarea v-model="u.note" class="field-input mt-1" maxlength="1000" rows="2" /></div>
            </template>
            <template v-else-if="draft.intent === 'incident' || draft.intent === 'assistance'">
              <label class="block text-[13px] font-medium">Title<input v-model="draft.title" class="field-input mt-1" maxlength="160" /></label>
              <label class="block text-[13px] font-medium">Details<textarea v-model="draft.description" class="field-input mt-1" rows="5" maxlength="2000" /></label>
              <label class="block text-[13px] font-medium">Severity<select v-model="draft.severity" class="field-input mt-1"><option v-for="s in ['low', 'medium', 'high', 'critical']" :key="s" :value="s">{{ s }}</option></select></label>
              <label class="flex items-center gap-2 text-[13px]"><input v-model="draft.is_safety" type="checkbox" class="size-4 accent-accent" />Safety concern</label>
            </template>
            <template v-else-if="draft.intent === 'task_update'">
              <label class="block text-[13px]">Issue code<input v-model="draft.issue_code" class="field-input mt-1" placeholder="ISS-000001" /></label>
              <label class="block text-[13px]">Update<select v-model="draft.transition" class="field-input mt-1"><option value="in_progress">Being worked on</option><option value="resolution_submitted">Done — request supervisor check</option></select></label>
              <label class="block text-[13px]">What did you do?<textarea v-model="draft.note" class="field-input mt-1" rows="4" maxlength="2000" /></label>
            </template>
          </fieldset>
          <ul v-if="missing.length" class="mt-4 list-disc space-y-1 pl-4 text-[12px] text-warn"><li v-for="m in missing" :key="m">{{ m }}</li></ul>
          <UiButton v-if="!compact" class="mt-5" variant="primary" block :loading="busy" :disabled="Boolean(missing.length)" @click="review">Review and confirm</UiButton>
        </component>
        <UiButton v-if="compact && preparation && !preparation.result && !['status','unsupported'].includes(draft.intent)" variant="primary" block :loading="busy" :disabled="Boolean(missing.length)" @click="review">Review and confirm</UiButton>
        <section class="rounded-lg border border-line bg-surface/50 p-5 text-[13px] text-ink-2">
          <h2 class="font-semibold text-ink">You stay in control</h2>
          <ol class="mt-3 space-y-3"><li><span class="mr-2 text-accent">01</span>Describe your work or request</li><li><span class="mr-2 text-accent">02</span>Review the prepared summary</li><li><span class="mr-2 text-accent">03</span>Confirm before anything is sent</li></ol>
          <p class="mt-4 border-t border-line pt-4 text-[12px] text-ink-3">Your supervisor still reviews reports and verifies resolved issues. Only your authorized workplace data is available.</p>
          <RouterLink to="/reports" class="link mt-3 inline-block text-[12px]">View my reports →</RouterLink>
        </section>
      </aside>
    </div>

    <UiDialog :open="confirming" :title="`Confirm ${intentLabel.toLowerCase()}?`" description="Review the final details. This action records them in the workplace system." @close="!busy && (confirming = false)">
      <ReportContentView v-if="draft.intent === 'report'" :content="draft.content" />
      <div v-else class="space-y-3 text-[14px] whitespace-pre-wrap">
        <template v-if="draft.intent === 'task_update'"><p class="font-semibold">{{ draft.issue_code }} · {{ draft.transition === 'resolution_submitted' ? 'Request verification' : 'In progress' }}</p><p>{{ draft.note }}</p></template>
        <template v-else><p class="font-semibold">{{ draft.title }}</p><p>{{ draft.description }}</p><p>Severity: {{ draft.severity }}{{ draft.is_safety ? ' · Safety concern' : '' }}</p></template>
      </div>
      <template #footer><UiButton :disabled="busy" @click="confirming = false">Keep editing</UiButton><UiButton variant="primary" :loading="busy" @click="confirm">Confirm and send</UiButton></template>
    </UiDialog>
  </div>
</template>
