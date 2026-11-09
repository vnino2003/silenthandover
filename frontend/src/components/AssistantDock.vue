<script setup lang="ts">
import { IonButton, IonChip, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useAuth } from '@/stores/auth';
import { useMica } from '@/stores/mica';
import { micaSuggestions, type MicaSuggestion } from '@/lib/mica-context';
import { useDictation } from '@/composables/useDictation';
import AssistantWorkbench from './AssistantWorkbench.vue';
import MicaMascot from './MicaMascot.vue';
import UiButton from './ui/UiButton.vue';
const props=defineProps<{embedded?:boolean}>();
const route=useRoute(),router=useRouter(),auth=useAuth(),session=useMica();
const {open,initialized,mode,question,helpBusy,helpError}=storeToRefs(session);
const launcher=ref<HTMLButtonElement|null>(null),panel=ref<HTMLElement|null>(null);
const workbench=ref<InstanceType<typeof AssistantWorkbench>|null>(null);
const panelId=useId(), questionId=useId();
const context=computed(()=>route.path==='/assistant' && session.workspaceContext ? session.workspaceContext : ({page:route.meta.assistantPage ?? 'assistant',...(typeof route.params.id==='string'?{entity_id:route.params.id}:{})}));
const contextKey=computed(()=>session.key(context.value));
const title=computed(()=>route.path==='/assistant' && session.workspaceTitle ? session.workspaceTitle : String(route.meta.title ?? 'This page'));
const turns=computed(()=>session.turns.filter(t=>t.key===contextKey.value));
const latest=computed(()=>turns.value.at(-1));
const factRows=computed(()=>latest.value?.answer.facts.filter(g=>!g.title.startsWith('Proposed dates')).flatMap(g=>g.items.length?g.items.map(i=>({label:g.title+' · '+i.label,value:i.value,href:i.link})):[{label:g.title,value:g.empty ?? 'None',href:undefined}]) ?? []);
const suggestions=computed(()=>micaSuggestions(context.value.page,auth.role));
if(props.embedded && typeof route.query.preparation==='string') mode.value='prepare';
const visible=computed(()=>props.embedded || (open.value && route.path!=='/assistant'));
const dictation=useDictation(text=>{question.value=[question.value.trim(),text].filter(Boolean).join(' ').slice(0,2000);});
watch(dictation.phase,phase=>{if(visible.value && mode.value==='help') session.voice=phase;});
watch([visible,mode],()=>{if(!visible.value || mode.value!=='help') {dictation.cancel();session.voice='idle';}});
watch(contextKey,()=>{session.stopHelp();helpError.value='';dictation.cancel();});
async function toggle() {
  if(props.embedded) {open.value=false;await router.push(session.workspaceReturnPath || auth.homePath);return;}
  open.value=!open.value;
  if(open.value) {initialized.value=true;session.lastEvent='attentive';await nextTick();panel.value?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});}
  else {dictation.cancel();await nextTick();launcher.value?.focus({preventScroll:true});}
}
function onKey(e:KeyboardEvent) {if(e.key==='Escape' && visible.value && !document.querySelector('[aria-modal="true"]')) {e.preventDefault();void toggle();}}
function onOpen(e:Event) {
  if(route.path==='/assistant') return;
  mode.value=auth.role==='employee' && (e as CustomEvent).detail==='prepare'?'prepare':'help';
  if(!open.value) void toggle();
}
const availableHeight=ref(700),keyboardOffset=ref(0);
function syncViewport() {const vv=window.visualViewport;availableHeight.value=vv?.height ?? window.innerHeight;keyboardOffset.value=Math.max(0,window.innerHeight-(vv?.height ?? window.innerHeight)-(vv?.offsetTop ?? 0));}
function syncVisibility() {document.documentElement.toggleAttribute('data-mica-paused',document.hidden);if(document.hidden) {dictation.cancel();session.voice='idle';}}
if(!props.embedded) {window.addEventListener('sh:assistant-open',onOpen);document.addEventListener('keydown',onKey);document.addEventListener('visibilitychange',syncVisibility);window.visualViewport?.addEventListener('resize',syncViewport);syncVisibility();syncViewport();}
onBeforeUnmount(()=>{if(!props.embedded) {window.removeEventListener('sh:assistant-open',onOpen);document.removeEventListener('keydown',onKey);document.removeEventListener('visibilitychange',syncVisibility);window.visualViewport?.removeEventListener('resize',syncViewport);document.documentElement.removeAttribute('data-mica-paused');}dictation.cancel();});
async function prepare(text:string) {dictation.cancel();mode.value='prepare';session.message=text;session.initialized=true;await nextTick();workbench.value?.start(text);await nextTick();if(session.draft.intent==='report' && !session.shiftId)panel.value?.querySelector<HTMLIonSelectElement>('.assistant-compact ion-select')?.open();}
async function choose(item:MicaSuggestion) {if(item.kind==='prepare' && auth.role==='employee') return prepare(item.message);if(item.kind==='leave') return openLeave();await session.ask(context.value,item.message);}
async function ask() {
  if(!question.value.trim()) return;
  const text=question.value.trim();dictation.cancel();
  if(auth.role==='employee' && /\b(prepare|draft|record|report)\b.*\b(endorsement|handover|shift report|incident|concern)\b/i.test(text)) {question.value='';return prepare(text);}
  await session.ask(context.value,text);
}
async function openLeave() {session.leaveDraft=latest.value?.answer.leave_draft ?? null;session.open=false;await router.push({path:'/leave',query:{prepare:'mica'}});}
</script>
<template>
  <div v-show="embedded || route.path !== '/assistant'" :class="embedded ? 'mica-embedded' : ['assistant-dock',{'mica-is-open':open}]" :data-keyboard="keyboardOffset>80" :style="{'--mica-available-height':`${availableHeight}px`,'--mica-keyboard-offset':`${keyboardOffset}px`}">
    <Transition name="mica-panel">
      <section v-if="initialized || embedded" v-show="open || embedded" :id="panelId" ref="panel" role="dialog" aria-label="Mica unit assistant" aria-modal="false" :class="{'mica-expanded-content': Boolean(latest) || mode==='prepare'}" class="mica-panel flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <header class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <MicaMascot :size="48" :state="session.state" :animated="visible" />
          <div class="min-w-0 flex-1"><h2 class="text-[14px] font-semibold">Mica <span class="ml-1 text-[11px] font-normal text-ink-3">your work companion</span></h2><p class="mica-state-label mt-0.5 text-[11px] text-ink-3" role="status" aria-live="polite">{{ session.stateLabel }}</p></div>
          <RouterLink v-if="!embedded" to="/assistant" @click="session.workspaceContext=context;session.workspaceTitle=title;session.workspaceReturnPath=route.fullPath" class="grid size-9 place-items-center rounded-md text-ink-3 hover:bg-sunken" aria-label="Expand Mica workspace">↗</RouterLink>
          <IonButton fill="clear" class="sh-ghost sh-md" aria-label="Close Mica" @click="toggle">✕</IonButton>
        </header>
        <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-canvas/60 px-4 py-2 text-[11px]">
          <span :key="contextKey" class="mica-context truncate text-ink-3">{{ auth.profile?.department_name ?? 'Organization' }} <span class="mx-1">/</span>{{ title }}</span>
          <UiButton size="sm" variant="ghost" v-if="mode==='prepare'" class="shrink-0" @click="mode='help'">← Page help</UiButton>
          <UiButton v-else-if="session.preparation && auth.role==='employee'" size="sm" variant="ghost" class="shrink-0" @click="mode='prepare'">Resume draft →</UiButton>
        </div>
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ latest?.answer.reply ?? '' }}</p>
        <div class="mica-content min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <div v-show="mode==='help'" class="mica-mode-content space-y-5">
            <div v-if="!latest" class="mica-intro flex items-start gap-3 py-2">
              <img src="/assistant/mica-folio.png" alt="" width="72" height="88" class="h-[88px] w-[72px] shrink-0 object-contain" />
              <div class="pt-2"><h3 class="text-[17px] leading-snug font-semibold">Let’s move your work forward.</h3><p class="mt-2 text-[13px] leading-relaxed text-ink-2">Ask about this page, or turn a rough note into your next step.</p></div>
            </div>
            <div class="mica-suggestions flex flex-wrap gap-2" aria-label="Suggested next steps"><IonChip v-for="item in suggestions" :key="item.label" outline class="mica-suggestion m-0 text-[12px]" :disabled="helpBusy" @click="choose(item)">{{ item.label }}<span class="ml-1 text-ink-3" aria-hidden="true">↗</span></IonChip></div>
            <details v-if="turns.length>1" class="text-[12px] text-ink-3"><summary class="cursor-pointer">Earlier on this page · {{ turns.length-1 }}</summary><div v-for="(turn,index) in turns.slice(0,-1)" :key="index" class="mt-3 space-y-2 border-l border-line pl-3"><p class="font-medium text-ink-2">{{ turn.question }}</p><p class="whitespace-pre-wrap leading-relaxed">{{ turn.answer.reply }}</p></div></details>
            <section v-if="latest" :key="turns.length" class="mica-reply" aria-label="Mica response">
              <p class="mb-3 border-l-2 border-accent/30 pl-3 text-[12px] leading-relaxed text-ink-3">{{ latest.question }}</p>
              <p class="mb-2 text-[10px] font-medium tracking-wide text-ink-3 uppercase">{{ latest.answer.engine==='records' ? 'From your records' : latest.answer.engine==='guide' ? 'Page guide' : 'Mica · AI guidance' }}</p>
              <div class="mica-answer-text space-y-3 text-[13px] leading-relaxed text-ink-2"><p v-for="(paragraph,index) in latest.answer.reply.split(/\n\s*\n/)" :key="index" class="whitespace-pre-wrap">{{ paragraph }}</p></div>
              <p v-if="latest.answer.notices.length" class="mt-3 text-[12px] leading-relaxed text-ink-3" role="status">{{ latest.answer.notices.join(' ') }}</p>
              <div v-if="latest.answer.leave_draft && auth.role!=='admin'" class="mt-4 rounded-lg border border-accent/20 bg-accent-soft p-3"><p class="text-[11px] font-medium text-accent-ink">Proposed dates · nothing submitted</p><p class="mt-1 text-[13px] text-ink-2">{{ latest.answer.leave_draft.start_date }} — {{ latest.answer.leave_draft.end_date }}</p><UiButton class="mt-3" size="sm" @click="openLeave">Review dates in Leave →</UiButton></div>
              <details v-if="factRows.length" class="mt-4 rounded-lg border border-line bg-canvas/50 p-3" open><summary class="cursor-pointer text-[12px] font-medium">From your authorized records <span class="font-normal text-ink-3">· {{ new Date(latest.answer.checked_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) }}</span></summary><dl class="mt-2 divide-y divide-line"><div v-for="(fact,index) in factRows" :key="index" class="py-3"><dt class="mb-1 text-[11px] font-medium text-ink-3">{{ fact.label }}</dt><dd class="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{{ fact.value }}</dd><RouterLink v-if="fact.href" :to="fact.href" class="mt-1 inline-block text-[11px] text-accent hover:underline">Open source →</RouterLink></div></dl><p class="text-[10px] leading-relaxed text-ink-3">These facts stay inside Silent Handover. They are not sent to the AI provider.</p></details>

            </section>
            <div v-if="helpBusy" class="mica-working flex items-center justify-between gap-3 py-3 text-[12px] text-ink-3" role="status"><span>Working on your question…</span><UiButton size="sm" variant="ghost" class="shrink-0" @click="session.stopHelp">Stop waiting</UiButton></div>
            <div v-if="helpError" role="alert" class="rounded-lg border border-bad/20 bg-bad-soft p-3 text-[12px] leading-relaxed text-bad">{{ helpError }}<UiButton size="sm" variant="ghost" class="mt-2 block" @click="ask">Try again</UiButton></div>
          </div>
          <AssistantWorkbench ref="workbench" v-if="auth.role==='employee'" v-show="mode==='prepare'" compact :restore-route="embedded" :active="visible && mode==='prepare'" :context="context" />
        </div>
        <form v-show="mode==='help'" class="mica-composer shrink-0 border-t border-line bg-surface p-3" @submit.prevent="ask">
          <label :for="questionId" class="sr-only">Ask Mica</label><IonTextarea :id="questionId" v-model="question" class="field-input min-h-16 resize-none border-transparent bg-canvas shadow-none" :rows="2" :maxlength="2000" placeholder="Ask, describe, or follow up…" @keydown.ctrl.enter.prevent="ask" @keydown.meta.enter.prevent="ask" :disabled="dictation.phase.value!=='idle'"  auto-grow />
          <div class="mt-2 flex items-center justify-between gap-2"><div class="flex items-center gap-2"><UiButton size="sm" variant="ghost" :disabled="!dictation.supported || helpBusy" :aria-pressed="dictation.listening.value" @click="dictation.phase.value==='idle' ? dictation.start(session.language) : dictation.stop()">{{ dictation.phase.value==='idle' ? 'Use voice' : 'Stop voice' }}</UiButton><IonSelect v-model="session.language" class="max-w-24 rounded border border-line bg-surface p-1 text-[11px]" aria-label="Voice language" :disabled="dictation.phase.value!=='idle'" interface="popover"><IonSelectOption value="en-PH">English</IonSelectOption><IonSelectOption value="fil-PH">Filipino</IonSelectOption></IonSelect></div><UiButton type="submit" size="sm" variant="primary" :disabled="!question.trim() || helpBusy || dictation.phase.value!=='idle'">Ask Mica <span aria-hidden="true">↑</span></UiButton></div>
          <p v-if="dictation.error.value" role="alert" class="mt-2 text-[11px] text-bad">{{ dictation.error.value }}</p>
          <p class="mt-2 text-[10px] leading-relaxed text-ink-3">{{ dictation.phase.value!=='idle' ? session.stateLabel+' · review the transcript before sending.' : 'Voice becomes editable text; your browser may process audio externally.' }} Nothing is submitted from page help.</p>
        </form>
      </section>
    </Transition>
    <Transition name="mica-launcher"><button v-if="!embedded" v-show="!open" ref="launcher" type="button" class="mica-launcher flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-4 pl-1 shadow-pop hover:border-accent/40" aria-label="Open Mica assistant" :aria-controls="panelId" :aria-expanded="open" @click="toggle"><MicaMascot :size="40" :state="session.busy?'processing':'ready'" /><span class="text-[12px] font-semibold text-ink-2">Ask Mica</span><i v-if="session.preparation" class="size-1.5 rounded-full bg-accent" aria-label="Preparation available" /></button></Transition>
  </div>
</template>
