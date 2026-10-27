import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { AssistantState, MicaAnswer, type AssistantView, type AssistantContext, type IssueStatus, type ReportStatus } from '@sh/shared';
import { useAuth } from './auth';
import { api, errorMessage } from '@/lib/api';
import type { ShiftView } from '@/lib/types';

export type MicaState = 'ready' | 'attentive' | 'requesting' | 'listening' | 'transcribing' | 'processing' | 'response' | 'recorded' | 'unavailable';
interface Status { reports: {id:string;reference_code:string;status:ReportStatus}[]; issues:{id:string;code:string;title:string;status:IssueStatus}[];checked_at:string }
interface Turn { key:string; question:string; answer:MicaAnswer }
export const useMica = defineStore('mica', () => {
  const auth = useAuth();
  const open = ref(false), initialized = ref(false);
  const mode = ref<'help'|'prepare'>('help');
  const preparation = ref<AssistantView|null>(null), draft = ref(AssistantState.parse({}));
  const message = ref(''), busy = ref(false), error = ref(''), confirming = ref(false);
  const shifts = ref<ShiftView[]>([]), shiftId = ref(''), language = ref('en-PH');
  const messages = ref<{who:'you'|'assistant';text:string}[]>([]), status = ref<Status|null>(null);
  const question = ref(''), helpBusy = ref(false), helpError = ref(''), turns = ref<Turn[]>([]);
  const voice = ref<'idle'|'requesting'|'listening'|'transcribing'>('idle');
  const lastEvent = ref<MicaState>('ready');
  const leaveDraft = ref<{start_date:string;end_date:string}|null>(null);
  const workspaceContext=ref<AssistantContext|null>(null),workspaceTitle=ref(''),workspaceReturnPath=ref('/');
  const state = computed<MicaState>(()=>voice.value !== 'idle' ? voice.value : busy.value || helpBusy.value ? 'processing' : (mode.value==='prepare' ? error.value : helpError.value) ? 'unavailable' : lastEvent.value);
  const stateLabel = computed(()=>({ready:'Ready when you are',attentive:'Here with you',requesting:'Starting microphone…',listening:'Listening',transcribing:'Finishing transcript…',processing:'Working on your request…',response:'Ready to continue',recorded:'Saved to your records',unavailable:'Let’s find another way'}[state.value]));
  let controller:AbortController|null = null, requestNumber=0;
  function stopHelp() { requestNumber++; controller?.abort(); controller=null; helpBusy.value=false; lastEvent.value='ready'; }
  function key(context:AssistantContext) { return `${context.page}:${context.entity_id ?? ''}`; }
  async function ask(context:AssistantContext,text=question.value) {
    if (helpBusy.value || !text.trim()) return;
    const submitted=text.trim(), sequence=++requestNumber;
    controller=new AbortController(); helpBusy.value=true; helpError.value='';
    try {
      const answer=MicaAnswer.parse(await api.post('/assistant/help',{message:submitted,...context},{signal:controller.signal}));
      if(sequence!==requestNumber) return;
      turns.value.push({key:key(context),question:submitted,answer});
      turns.value=turns.value.slice(-12);
      if(!answer.fallback && question.value.trim()===submitted) question.value='';
      lastEvent.value=answer.fallback?'unavailable':'response';
    } catch(e) { if(sequence===requestNumber) helpError.value=errorMessage(e); }
    finally { if(sequence===requestNumber) { helpBusy.value=false; controller=null; } }
  }
  function reset() {
    stopHelp(); open.value=false; initialized.value=false; mode.value='help'; preparation.value=null; draft.value=AssistantState.parse({});
    message.value='';busy.value=false;error.value='';confirming.value=false;shifts.value=[];shiftId.value='';messages.value=[];status.value=null;
    question.value='';helpError.value='';turns.value=[];voice.value='idle';lastEvent.value='ready';leaveDraft.value=null;workspaceContext.value=null;workspaceTitle.value='';workspaceReturnPath.value='/';
  }
  watch(()=>[auth.profile?.id,auth.profile?.role,auth.profile?.department_id].join('|'),reset);
  return {open,initialized,mode,preparation,draft,message,busy,error,confirming,shifts,shiftId,language,messages,status,question,helpBusy,helpError,turns,voice,lastEvent,leaveDraft,workspaceContext,workspaceTitle,workspaceReturnPath,state,stateLabel,ask,stopHelp,key,reset};
});
