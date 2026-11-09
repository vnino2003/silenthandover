import { onBeforeUnmount, ref } from 'vue';

interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

/** Speech only fills an editable transcript. It never sends or confirms a request. */
export function useDictation(onTranscript: (text: string) => void) {
  const Speech = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
  const supported = Boolean(Speech) && window.isSecureContext;
  const listening = ref(false);
  const phase = ref<'idle'|'requesting'|'listening'|'transcribing'>('idle');
  const error = ref('');
  let recognition: Recognition | null = null;
  function start(lang = 'en-PH') {
    error.value = '';
    if (!Speech || !supported) { error.value = 'Voice is unavailable in this browser. Type your message below.'; return; }
    cancel();
    recognition = new Speech();
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => { listening.value = true; phase.value = 'listening'; };
    recognition.onaudiostart = () => { listening.value = true; phase.value = 'listening'; };
    recognition.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ').trim();
      if (text) onTranscript(text);
    };
    recognition.onerror = (e) => {
      listening.value = false;
      phase.value = 'idle';
      error.value = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access was denied. Allow it in your browser or type your message.'
        : e.error === 'no-speech' ? 'No speech was detected. Try again or type your message.'
          : 'Voice recognition could not finish. You can type your message instead.';
    };
    recognition.onend = () => { listening.value = false; phase.value = 'idle'; };
    try { phase.value = 'requesting'; recognition.start(); }
    catch { listening.value = false; phase.value = 'idle'; error.value = 'Could not start the microphone. Type your message or try again.'; }
  }
  function stop() { if(phase.value==='requesting') return cancel(); if (phase.value !== 'idle') { listening.value = false; phase.value = 'transcribing'; try{recognition?.stop();}catch{cancel();} } }
  function cancel() {
    if (recognition) { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; recognition.onstart = null; recognition.onaudiostart = null; recognition.abort(); recognition = null; }
    listening.value = false; phase.value = 'idle';
  }
  const visibility=()=>{if(document.hidden)cancel();};
  if(typeof document!=='undefined') document.addEventListener('visibilitychange',visibility);
  onBeforeUnmount(()=>{cancel();if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visibility);});
  return { supported, listening, phase, error, start, stop, cancel };
}
