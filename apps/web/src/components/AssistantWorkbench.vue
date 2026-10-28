<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AssistantState, assistantMissing, REPORT_SECTIONS, type AssistantView, type IssueStatus, type ReportStatus, type AssistantContext } from '@sh/shared';
import MicaMascot from './MicaMascot.vue';
import { storeToRefs } from 'pinia';
import { useMica } from '@/stores/mica';
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

const props = withDefaults(defineProps<{ compact?: boolean; active?: boolean; restoreRoute?:boolean; context?: AssistantContext }>(), { active: true });
const auth = useAuth();
const scope=()=>[auth.profile?.id,auth.profile?.role,auth.profile?.department_id].join('|');
const sessionOwner=scope();
const ownsSession=()=>scope()===sessionOwner;
const fieldPrefix = useId();
const route = useRoute();
const router = useRouter();
const session=useMica();
const {preparation,draft,message,busy,error,confirming,shifts,shiftId,language,messages,status}=storeToRefs(session);
const dictation=useDictation((text)=>{message.value=[message.value.trim(),text].filter(Boolean).join(' ').slice(0,6000);});
watch(()=>props.active,(active)=>{if(!active) {dictation.cancel();session.voice='idle';}});
watch(dictation.phase,(phase)=>{if(props.active) session.voice=phase;});
onBeforeUnmount(()=>{if(props.active) session.voice='idle';});
const selectableShifts = computed(() => shifts.value.filter((s) => !s.report_status || ['draft', 'revision_requested'].includes(s.report_status)));
const missing = computed(() => {
  const list = assistantMissing(draft.value);
  if (draft.value.intent === 'report' && !preparation.value?.shift_id) list.push('Start a new conversation and select an assigned shift');
  return list;
});
const receiptPath = computed(() => preparation.value?.result ? `${['report','draft'].includes(preparation.value.result.kind) ? '/reports' : '/tasks'}/${preparation.value.result.id}` : '/reports');
const intentLabel = computed(() => ({ report: auth.experience.report_label, incident: 'Incident report', assistance: 'Assistance request', task_update: 'Task update', status: 'Workplace status', leave:'Leave preparation', unsupported: 'Choose a task' })[draft.value.intent]);

function accept(p: AssistantView) {
  if(!ownsSession()) return;
  preparation.value = p;
  draft.value = structuredClone(p.state);
  shiftId.value = p.shift_id ?? '';
}
async function refreshStatus() {
  try { const response=await api.get<NonNullable<typeof status.value>>('/assistant/status');if(ownsSession())status.value=response; }
  catch (e) { if(ownsSession())error.value=errorMessage(e); }
}
async function reload() {
  if (!preparation.value && ((props.compact && !props.restoreRoute) || !route.query.preparation)) return;
  busy.value = true; error.value = '';
  try {
    accept(await api.get<AssistantView>(`/assistant/preparations/${preparation.value?.id ?? route.query.preparation}`));
    if(!ownsSession() || !preparation.value)return;
    messages.value = [{ who: 'assistant', text: preparation.value.reply }];
    if (draft.value.intent === 'status') await refreshStatus();
  } catch (e) { if(ownsSession()) error.value = errorMessage(e); }
  finally { if(ownsSession()) busy.value = false; }
}
onMounted(async () => {
  try {
    if (!shifts.value.length) {const response=await api.get<ShiftView[]>('/employee/shifts');if(!ownsSession())return;shifts.value=response;}
    if (!preparation.value && !shiftId.value) shiftId.value = typeof route.params.shiftId==='string' ? route.params.shiftId : typeof route.query.shift === 'string' ? route.query.shift : selectableShifts.value.find((s) => ['open', 'override', 'early_draft'].includes(s.window_state ?? ''))?.id ?? '';
  } catch (e) { if(ownsSession())error.value=errorMessage(e); }
  if (!preparation.value && (!props.compact || props.restoreRoute) && route.query.preparation) await reload();
});
async function send(text = message.value) {
  if (busy.value || !ownsSession() || !text.trim() || preparation.value?.result || (draft.value.intent==='report' && !shiftId.value)) return;
  dictation.stop(); busy.value = true; error.value = '';
  try {
    // Carry edits from the summary into the conversation rather than losing them on the next reply.
    if (preparation.value && JSON.stringify(draft.value) !== JSON.stringify(preparation.value.state)) {
      accept(await api.put<AssistantView>(`/assistant/preparations/${preparation.value.id}`, { version: preparation.value.version, state: draft.value }));
    }
    if(!ownsSession())return;
    const p = await api.post<AssistantView>('/assistant/message', {
      message: text,
      context: props.context,
      ...(preparation.value ? { preparation_id: preparation.value.id, version: preparation.value.version } : { shift_id: shiftId.value || null }),
    });
    if(!ownsSession())return;
    accept(p);
    messages.value.push({ who: 'you', text }, { who: 'assistant', text: p.reply });
    if(message.value===text) message.value = '';
    session.lastEvent=p.engine==='guided_unavailable'?'unavailable':'response';
    if ((!props.compact || props.restoreRoute) && route.path==='/assistant') await router.replace({ path: '/assistant', query: { preparation: p.id } });
    if (p.state.intent === 'status') await refreshStatus();
  } catch (e) { if(ownsSession())error.value=errorMessage(e); }
  finally { if(ownsSession())busy.value=false; }
}
async function review() {
  if (!preparation.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const p = await api.put<AssistantView>(`/assistant/preparations/${preparation.value.id}`, { version: preparation.value.version, state: draft.value });
    accept(p);
    if (ownsSession() && p.ready) confirming.value = true;
  } catch (e) { if(ownsSession())error.value=errorMessage(e); }
  finally { if(ownsSession())busy.value=false; }
}
async function confirm() {
  if (!preparation.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    accept(await api.post<AssistantView>(`/assistant/preparations/${preparation.value.id}/confirm`, { version: preparation.value.version, confirmed: true }));
    if(!ownsSession())return;
    confirming.value = false;session.lastEvent='recorded';
  } catch (e) { if(ownsSession()){error.value=errorMessage(e);confirming.value=false;} }
  finally { if(ownsSession())busy.value=false; }
}
async function openReportForm() {
  if(!preparation.value || busy.value) return;
  busy.value=true;error.value='';
  try {
    accept(await api.put<AssistantView>(`/assistant/preparations/${preparation.value.id}`,{version:preparation.value.version,state:draft.value}));
    accept(await api.post<AssistantView>(`/assistant/preparations/${preparation.value.id}/draft`,{version:preparation.value.version}));
    if(!ownsSession())return;
    session.lastEvent='recorded';session.open=false;
    await router.push(receiptPath.value);
  }catch(e){if(ownsSession())error.value=errorMessage(e);}finally{if(ownsSession())busy.value=false;}
}
function reset() {
  dictation.cancel(); preparation.value = null; messages.value = []; status.value = null;
  draft.value = AssistantState.parse({}); message.value = ''; error.value = '';session.lastEvent='ready';
  if ((!props.compact || props.restoreRoute) && route.path==='/assistant') void router.replace('/assistant');
}
function start(text:string) {
  message.value=text;
  if(/\b(shift report|handover)\b/i.test(text) && !shiftId.value) {draft.value.intent='report';return;}
  void send(text);
}
defineExpose({start});
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
        <div v-if="!preparation && !compact" class="assistant-hero rounded-lg border border-accent/15 p-5 sm:p-7">
          <MicaMascot :size="compact ? 48 : 64" :animated="active" :thinking="busy" :mood="dictation.listening.value ? 'listening' : 'welcome'" />
          <h2 class="mt-2 text-[20px] font-semibold tracking-tight">Let’s make the handover easier.</h2>
          <p class="mt-2 max-w-md text-[13px] leading-relaxed text-ink-2">Describe your work or choose a starting point. I’ll prepare the details for you to review.</p>
          <div class="mt-5 grid gap-2 sm:grid-cols-2">
            <button v-for="item in [{ title: 'Prepare my shift report', text: 'I want to submit my daily shift report', icon: '/reports' }, { title: 'Record an incident', text: 'I want to report an incident', icon: '/tasks' }, { title: 'Request assistance', text: 'I need assistance from my supervisor', icon: '/assistant' }, { title: 'Check my status', text: 'Check the status of my reports and issues', icon: '/handover' }]" :key="item.title" :disabled="busy" class="mica-suggestion flex items-center gap-3 rounded-md border border-line bg-surface/90 px-4 py-3 text-left text-[13px] font-medium hover:border-accent disabled:opacity-50" @click="send(item.text)">
              <NavIcon :path="item.icon" />{{ item.title }}<span class="ml-auto text-ink-3" aria-hidden="true">↗</span>
            </button>
          </div>
        </div>

        <div v-if="draft.intent === 'report' || (!compact && !preparation)" class="card p-4">
          <label :for="`${fieldPrefix}-shift`" class="block text-[13px] font-medium">Reporting shift <span class="font-normal text-ink-3">· required for {{ auth.terms.reports.toLowerCase() }}</span></label>
          <select :id="`${fieldPrefix}-shift`" v-model="shiftId" class="field-input mt-2" :disabled="Boolean(preparation) || busy">
            <option value="">Select an assigned shift</option>
            <option v-for="s in selectableShifts" :key="s.id" :value="s.id">{{ s.label }} · {{ dateTime(s.starts_at) }} · {{ shiftRange(s) }}</option>
          </select>
          <p class="mt-2 text-[12px] text-ink-3">{{ preparation ? 'To change shift, start a new conversation.' : 'You can report incidents or request help without an active shift.' }}</p>
        </div>

        <div v-if="preparation" class="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span class="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent-ink">{{ preparation.engine.startsWith('guided') ? 'Guided preparation' : `${preparation.engine} · AI assisted` }}</span>
          <span>Preparation expires {{ dateTime(preparation.expires_at) }}</span>
        </div>
        <p v-if="preparation?.notices?.length" class="text-[12px] leading-relaxed text-ink-3" role="status">{{ preparation.notices.join(' ') }}</p>
        <div v-if="messages.length" role="log" aria-label="Conversation" aria-live="polite" class="space-y-4">
          <div v-for="(m, index) in messages" :key="index" class="mica-message flex" :class="m.who === 'you' ? 'justify-end' : ''">
            <div class="max-w-[95%] rounded-lg px-4 py-3 text-[14px] whitespace-pre-wrap" :class="m.who === 'you' ? 'border-l-2 border-accent/30 bg-sunken/60' : 'mica-answer-text'">
              <p class="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wider uppercase opacity-70">{{ m.who === 'you' ? 'You' : 'Mica' }}</p>{{ m.text }}
            </div>
          </div>
        </div>
        <p v-if="busy" role="status" class="flex items-center gap-2 text-[13px] text-ink-3">Preparing your request…</p>
        <div v-if="error" class="rounded-lg border border-bad/25 bg-bad-soft p-4 text-[14px] text-bad" role="alert">
          {{ error }}
          <button v-if="preparation" class="mt-2 block underline" :disabled="busy" @click="reload">Reload preparation</button>
        </div>

        <div v-if="preparation?.result" class="mica-receipt card border-ok/30 bg-ok-soft p-5" role="status">
          <h2 class="flex items-center gap-2 font-semibold text-ok"><MicaMascot :size="32" :animated="active" mood="success" />{{ preparation.result.kind === 'draft' ? 'Draft saved' : 'Request recorded' }}</h2>
          <p class="mt-1 text-[14px]">{{ preparation.result.reference }} · {{ preparation.result.status?.replaceAll('_', ' ') }}</p>
          <p class="mt-2 text-[13px] text-ink-2">{{ preparation.result.kind === 'draft' ? 'Your draft is saved. Open the report form to review and submit it.' : preparation.result.kind === 'report' ? 'Your supervisor will review it before the next shift receives it.' : 'Your update is saved. Completion claims still need supervisor verification.' }}</p>
          <UiButton class="mt-4" :to="receiptPath">View record and status</UiButton>
        </div>
        <form v-else class="assistant-composer card p-3 sm:p-4" :class="{ 'mica-listening-composer': dictation.listening.value }" @submit.prevent="send()">
          <label :for="`${fieldPrefix}-message`" class="sr-only">Message to workplace assistant</label>
          <textarea :id="`${fieldPrefix}-message`" v-model="message" class="field-input min-h-24 border-transparent bg-transparent shadow-none" rows="3" maxlength="6000" :disabled="busy || dictation.phase.value!=='idle'" placeholder="Tell me what you need help with…" @keydown.ctrl.enter.prevent="send()" @keydown.meta.enter.prevent="send()" />
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <div class="flex items-center gap-2">
              <UiButton size="sm" :disabled="busy || !dictation.supported" :aria-pressed="dictation.listening.value" @click="dictation.phase.value!=='idle' ? dictation.stop() : dictation.start(language)">{{ dictation.listening.value ? 'Stop listening' : 'Use voice' }}</UiButton>
              <select v-model="language" class="max-w-24 rounded-md border border-line bg-surface p-1.5 text-[12px]" aria-label="Voice language" :disabled="dictation.listening.value"><option value="en-PH">English</option><option value="fil-PH">Filipino</option></select>
            </div>
            <UiButton type="submit" variant="primary" :loading="busy" :disabled="!message.trim() || dictation.phase.value!=='idle' || (draft.intent==='report' && !shiftId)">Send message</UiButton>
          </div>
          <p class="mt-2 text-[11px] text-ink-3">{{ dictation.listening.value ? 'Listening… Your transcript will appear here for you to edit.' : dictation.supported ? 'Voice creates an editable transcript. Your browser may process audio through its speech service.' : 'Voice is unavailable in this browser. You can type every request.' }}</p>
          <p v-if="dictation.error.value" role="alert" class="mt-2 text-[12px] text-bad">{{ dictation.error.value }}</p>
        </form>

        <section v-if="status" class="card p-5" aria-label="Current status">
          <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold">Your latest records</h2><UiButton size="sm" @click="refreshStatus">Refresh status</UiButton></div>
          <p class="mt-1 text-[12px] text-ink-3">Checked {{ dateTime(status.checked_at) }}</p>
          <p v-if="!status.reports.length && !status.issues.length" class="mt-4 text-[14px] text-ink-3">No {{ auth.terms.reports.toLowerCase() }} or department {{ auth.terms.issues.toLowerCase() }} yet.</p>
          <ul class="mt-3 divide-y divide-line">
            <li v-for="r in status.reports" :key="r.id" class="flex flex-wrap items-center justify-between gap-2 py-3"><RouterLink :to="`/reports/${r.id}`" class="link text-[14px]">{{ r.reference_code }}</RouterLink><StatusBadge :report="r.status" /></li>
            <li v-for="i in status.issues" :key="i.id" class="flex flex-wrap items-center justify-between gap-2 py-3"><RouterLink :to="`/tasks/${i.id}`" class="link text-[14px]">{{ i.code }} · {{ i.title }}</RouterLink><StatusBadge :issue="i.status" /></li>
          </ul>
        </section>
      </section>

      <aside class="min-w-0 space-y-4">
        <component :is="compact ? 'details' : 'section'" v-if="preparation && !preparation.result && !['status', 'unsupported', 'leave'].includes(draft.intent)" class="card p-5" aria-label="Prepared action">
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
              <label class="block text-[13px]">{{ auth.terms.issue }} code<input v-model="draft.issue_code" class="field-input mt-1" placeholder="ISS-000001" /></label>
              <label class="block text-[13px]">Update<select v-model="draft.transition" class="field-input mt-1"><option value="in_progress">Being worked on</option><option value="resolution_submitted">Done — request supervisor check</option></select></label>
              <label class="block text-[13px]">What did you do?<textarea v-model="draft.note" class="field-input mt-1" rows="4" maxlength="2000" /></label>
            </template>
          </fieldset>
          <ul v-if="missing.length" class="mt-4 list-disc space-y-1 pl-4 text-[12px] text-warn"><li v-for="m in missing" :key="m">{{ m }}</li></ul>
          <UiButton v-if="!compact" class="mt-5" variant="primary" block :loading="busy" :disabled="Boolean(missing.length)" @click="review">Review and confirm</UiButton>
        </component>
        <UiButton v-if="compact && preparation && !preparation.result && !['status','unsupported','leave'].includes(draft.intent)" variant="primary" block :loading="busy" :disabled="Boolean(missing.length)" @click="review">Review and confirm</UiButton>
        <section class="rounded-lg border border-line bg-surface/50 p-5 text-[13px] text-ink-2">
          <h2 class="font-semibold text-ink">You stay in control</h2>
          <ol class="mt-3 space-y-3"><li><span class="mr-2 text-accent">01</span>Describe your work or request</li><li><span class="mr-2 text-accent">02</span>Review the prepared summary</li><li><span class="mr-2 text-accent">03</span>Confirm before anything is sent</li></ol>
          <p class="mt-4 border-t border-line pt-4 text-[12px] text-ink-3">Your {{ auth.terms.supervisor.toLowerCase() }} still reviews {{ auth.terms.reports.toLowerCase() }} and verifies resolved {{ auth.terms.issues.toLowerCase() }}. Only your authorized workplace data is available.</p>
          <RouterLink to="/reports" class="link mt-3 inline-block text-[12px]">View my reports →</RouterLink>
        </section>
        <UiButton v-if="preparation && !preparation.result && draft.intent === 'report' && preparation.shift_id" block :disabled="busy" @click="openReportForm">Open in report form</UiButton>
        <section v-if="preparation && !preparation.result && draft.intent==='leave'" class="card p-4 text-[13px]">
          <h3 class="font-medium">Continue in Leave</h3><p class="mt-2 text-ink-2">{{ draft.leave.start_date || 'Choose the first day' }} — {{ draft.leave.end_date || 'Choose the last day' }}</p>
          <UiButton class="mt-3" block @click="session.leaveDraft=draft.leave.start_date && draft.leave.end_date ? {start_date:draft.leave.start_date,end_date:draft.leave.end_date} : null;session.open=false;router.push('/leave?prepare=mica')">Review dates and leave type →</UiButton>
          <p class="mt-2 text-[11px] text-ink-3">Add your private reason and submit in the existing form.</p>
        </section>
      </aside>
    </div>

    <UiDialog :open="confirming && active" :title="`Confirm ${intentLabel.toLowerCase()}?`" description="Review the final details. This action records them in the workplace system." @close="!busy && (confirming = false)">
      <ReportContentView v-if="draft.intent === 'report'" :content="draft.content" />
      <div v-else class="space-y-3 text-[14px] whitespace-pre-wrap">
        <template v-if="draft.intent === 'task_update'"><p class="font-semibold">{{ draft.issue_code }} · {{ draft.transition === 'resolution_submitted' ? 'Request verification' : 'In progress' }}</p><p>{{ draft.note }}</p></template>
        <template v-else><p class="font-semibold">{{ draft.title }}</p><p>{{ draft.description }}</p><p>Severity: {{ draft.severity }}{{ draft.is_safety ? ' · Safety concern' : '' }}</p></template>
      </div>
      <template #footer><UiButton :disabled="busy" @click="confirming = false">Keep editing</UiButton><UiButton variant="primary" :loading="busy" @click="confirm">Confirm and send</UiButton></template>
    </UiDialog>
  </div>
</template>
