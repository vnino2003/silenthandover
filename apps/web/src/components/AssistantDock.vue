<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { AssistantPageContext } from '@sh/shared';
import { useAuth } from '@/stores/auth';
import { api, errorMessage } from '@/lib/api';
import AssistantWorkbench from './AssistantWorkbench.vue';
import MicaMascot from './MicaMascot.vue';
import UiButton from './ui/UiButton.vue';

const route = useRoute();
const auth = useAuth();
const open = ref(false);
const initialized = ref(false);
const mode = ref<'help' | 'prepare'>('help');
const launcher = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const question = ref('');
const answer = ref('');
const engine = ref('');
const busy = ref(false);
const error = ref('');
const page = computed<AssistantPageContext>(() => {
  const p = route.path;
  if (p === '/') return 'today';
  if (p === '/manager') return 'review';
  if (p.startsWith('/manager/reports/')) return 'review';
  if (p.startsWith('/reports/')) return 'report';
  if (p.includes('/shifts/') && p.endsWith('/report')) return 'report';
  if (p === '/manager/shifts') return 'today';
  if (/\/(tasks|issues)\//.test(p)) return 'issue';
  if (p.endsWith('/tasks') || p.endsWith('/issues')) return 'issues';
  if (p.endsWith('/ai-pipeline')) return 'pipeline';
  if (p === '/admin') return 'integrations';
  const last = p.split('/').filter(Boolean).at(-1);
  return (['reports','handover','schedule','records','departments','users','settings','profile','notifications','audit','assistant'].includes(last ?? '') ? last : 'assistant') as AssistantPageContext;
});
const context = computed(() => ({ page: page.value, ...(typeof route.params.id === 'string' ? { entity_id: route.params.id } : {}) }));
const title = computed(() => String(route.meta.title ?? 'Current page'));
watch(page, () => { answer.value = ''; error.value = ''; });
async function toggle() {
  open.value = !open.value;
  if (open.value) { initialized.value = true; await nextTick(); panel.value?.querySelector<HTMLButtonElement>('button')?.focus(); }
  else launcher.value?.focus();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value && !document.querySelector('[aria-modal="true"]')) { open.value = false; launcher.value?.focus(); }
}
function onOpen(e: Event) { mode.value = auth.role === 'employee' && (e as CustomEvent).detail === 'prepare' ? 'prepare' : 'help'; if (!open.value) void toggle(); }
window.addEventListener('sh:assistant-open',onOpen);
document.addEventListener('keydown',onKey);
onBeforeUnmount(() => { document.removeEventListener('keydown',onKey); window.removeEventListener('sh:assistant-open',onOpen); });
async function help(text = question.value || 'How do I use this page?') {
  if (busy.value) return;
  const requestedPage = page.value;
  busy.value = true; error.value = '';
  try {
    const response = await api.post<{ reply: string; engine: string }>('/assistant/help',{ message: text, page: requestedPage });
    if (page.value === requestedPage) { answer.value = response.reply; engine.value = response.engine; question.value = ''; }
  } catch(e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <div v-show="route.path !== '/assistant'" class="assistant-dock" :class="{ 'mica-is-open': open }">
    <section v-if="initialized" v-show="open" id="mica-panel" ref="panel" role="dialog" aria-label="Mica workplace assistant" aria-modal="false" class="mica-panel flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
      <header class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <MicaMascot :size="40" /><div class="min-w-0 flex-1"><h2 class="text-[14px] font-semibold">Mica <span class="ml-1 font-normal text-ink-3">· your work companion</span></h2><p class="truncate text-[11px] text-ink-3">{{ auth.profile?.department_name ?? 'Organization workspace' }}</p></div>
        <button type="button" class="grid size-9 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-sunken" aria-label="Close Mica" @click="toggle">✕</button>
      </header>
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2 text-[12px]">
        <span class="truncate text-ink-3">On this page: <span class="text-ink-2">{{ title }}</span></span>
        <div v-if="auth.role === 'employee'" class="flex shrink-0 gap-1" role="group" aria-label="Assistant mode"><button class="rounded px-2 py-1" :class="mode === 'help' ? 'bg-accent-soft text-accent-ink' : 'text-ink-3'" :aria-pressed="mode === 'help'" @click="mode = 'help'">Help</button><button class="rounded px-2 py-1" :class="mode === 'prepare' ? 'bg-accent-soft text-accent-ink' : 'text-ink-3'" :aria-pressed="mode === 'prepare'" @click="mode = 'prepare'">Prepare</button></div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div v-show="mode === 'help'" class="space-y-4">
          <div v-if="!answer" class="py-2"><MicaMascot :size="64" /><h3 class="mt-3 text-[17px] font-semibold">A little help, right where you are.</h3><p class="mt-2 text-[13px] leading-relaxed text-ink-2">I can explain {{ title.toLowerCase() }} and the next steps available to your role.</p><UiButton class="mt-4" size="sm" :loading="busy" @click="help('How do I use this page?')">Guide me through this page</UiButton></div>
          <div v-else class="rounded-lg border border-line bg-canvas p-4 text-[13px] leading-relaxed whitespace-pre-wrap"><p class="mb-2 flex items-center gap-2 font-medium"><MicaMascot :size="24" />Mica <span class="text-[10px] font-normal text-ink-3">{{ engine === 'guide' ? 'Page guide · no AI connected' : 'AI assisted' }}</span></p>{{ answer }}</div>
          <p v-if="busy" role="status" class="flex items-center gap-2 text-[12px] text-ink-3"><MicaMascot :size="28" thinking />Looking into your question…</p>
          <p v-if="error" role="alert" class="rounded-md bg-bad-soft p-3 text-[13px] text-bad">{{ error }}</p>
          <form class="space-y-2" @submit.prevent="help()"><label for="mica-question" class="sr-only">Ask Mica about this page</label><textarea id="mica-question" v-model="question" class="field-input" rows="2" maxlength="2000" placeholder="Ask about this page…" :disabled="busy" /><UiButton type="submit" size="sm" :disabled="!question.trim()" :loading="busy">Ask Mica</UiButton></form>
          <button v-if="auth.role === 'employee'" class="w-full rounded-md border border-accent/20 bg-accent-soft px-3 py-3 text-left text-[12px] text-accent-ink" @click="mode = 'prepare'">Prepare a report, record a concern, or update a task →</button>
          <p class="text-[11px] leading-relaxed text-ink-3">{{ auth.experience.privacy_hint }} Help does not submit or approve anything.</p>
        </div>
        <AssistantWorkbench v-if="auth.role === 'employee'" v-show="mode === 'prepare'" compact :active="open && mode === 'prepare' && route.path !== '/assistant'" :context="context" />
      </div>
    </section>
    <button v-show="!open" ref="launcher" type="button" class="mica-launcher flex items-center gap-2 rounded-full border border-line bg-surface py-1.5 pr-4 pl-1.5 shadow-pop hover:border-accent/40" aria-label="Open Mica assistant" aria-controls="mica-panel" :aria-expanded="open" @click="toggle"><MicaMascot :size="36" /><span class="text-[12px] font-semibold text-ink-2">Ask Mica</span></button>
  </div>
</template>
