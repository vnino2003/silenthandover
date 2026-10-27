<script setup lang="ts">
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge, { type Tone } from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, relative } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Integrations {
  adapters: {
    ai: { adapter: 'dev' | 'n8n' | 'admin'; provider: 'gemini' | 'grok' | null; model: string | null; simulated: boolean; webhook_configured: boolean; prompt_version: string };
    email: { transport: string; simulated: boolean; from: string };
    sms: { connected: boolean; transport: 'none' | 'n8n'; webhook_configured: boolean; from: string; note: string };
    callbacks: { enabled: boolean };
    scheduler: { internal: boolean; interval_ms: number };
  };
  eventCounts: { kind: string; status: string; count: number }[];
  events: { id: string; kind: string; status: string; adapter: string | null; attempts: number; max_attempts: number; last_error: string | null; created_at: string; department_name: string | null; next_attempt_at: string }[];
  deliveryCounts: { channel: string; status: string; count: number }[];
  deliveries: { id: string; channel: string; status: string; provider: string | null; attempts: number; max_attempts: number; last_error: string | null; created_at: string; recipient_name: string }[];
  overview: { department_name: string; status: string; count: number }[] | null;
  outbox: { id: string; address: string; provider_response: { subject?: string; preview?: string } | null; updated_at: string }[];
}

const auth = useAuth();
const toast = useToast();
const { data, loading, error, reload } = useAsync(() => api.get<Integrations>('/admin/integrations'));
const busy = ref<string | null>(null);

async function act(key: string, fn: () => Promise<unknown>, done: string) {
  busy.value = key;
  try {
    await fn();
    toast.ok(done);
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
const runTick = () =>
  act('tick', async () => {
    const r = await api.post<Record<string, number>>('/admin/tick');
    toast.info(Object.entries(r).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · '));
  }, 'Scheduled checks ran');

const confirmClear = ref(false);
const resetAll = () =>
  act('clear', async () => {
    const r = await api.post<{ cleared: { shifts: number; reports: number; issues: number } }>('/admin/activity/reset', { confirm: 'CLEAR' });
    confirmClear.value = false;
    toast.info(`Removed ${r.cleared.shifts} shifts, ${r.cleared.reports} reports and ${r.cleared.issues} tickets`);
  }, 'All activity reset');

// ---- AI provider: the administrator pastes the key here; it is stored encrypted, never shown again.
type Provider = 'simulator' | 'gemini' | 'grok';
interface AiSettingsView {
  provider: Provider;
  model: string | null;
  /** When the model is automatic: the one in use right now. */
  resolved_model: string | null;
  has_key: boolean;
  key_hint: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  encryption_available: boolean;
  providers: Record<'gemini' | 'grok', { label: string; keyUrl: string }>;
}
const PROVIDER_NOTE: Record<Provider, string> = {
  simulator: 'No AI is called. Drafts are made by a built-in rule-based simulator and clearly labeled as simulated.',
  gemini: 'Has a free tier. On the free tier Google may use what is sent to improve its products — names and contact details are removed first, but use a paid plan for real workplace data.',
  grok: 'Paid: needs credit on your xAI account.',
};
const aiTitle = computed(() => {
  const ai = data.value?.adapters.ai;
  if (!ai) return '';
  if (ai.provider === 'gemini') return 'Google Gemini';
  if (ai.provider === 'grok') return 'xAI Grok';
  return ai.adapter === 'n8n' && !ai.simulated ? 'n8n workflow' : 'Development simulator';
});
const ai = ref<AiSettingsView | null>(null);
const aiForm = ref<{ provider: Provider; model: string; api_key: string; removeKey: boolean } | null>(null);
const aiTest = ref<{ ok: boolean; text: string } | null>(null);
const showKey = ref(false);
// Models the key can use, newest first, and the one "automatic" would pick. Providers retire
// model names, so the list comes from the provider instead of being written into the app.
const models = ref<string[]>([]);
const suggestedModel = ref<string | null>(null);
const modelsError = ref<string | null>(null);
async function openAi() {
  try {
    ai.value = await api.get<AiSettingsView>('/admin/ai');
    aiForm.value = { provider: ai.value.provider, model: ai.value.model ?? '', api_key: '', removeKey: false };
    aiTest.value = null;
    showKey.value = false;
    models.value = [];
    suggestedModel.value = ai.value.resolved_model;
    modelsError.value = null;
    if (ai.value.has_key && ai.value.provider !== 'simulator') void loadModels();
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
async function loadModels() {
  const f = aiForm.value;
  if (!f || f.provider === 'simulator') return;
  busy.value = 'ai-models';
  modelsError.value = null;
  try {
    const r = await api.post<{ models: string[]; suggested: string | null }>('/admin/ai/models', {
      provider: f.provider,
      ...(f.api_key.trim() ? { api_key: f.api_key.trim() } : {}),
    });
    models.value = r.models;
    suggestedModel.value = r.suggested;
  } catch (err) {
    modelsError.value = errorMessage(err);
  } finally {
    busy.value = null;
  }
}
const providerInfo = computed(() => (aiForm.value && aiForm.value.provider !== 'simulator' ? ai.value?.providers[aiForm.value.provider] : null));
/** The saved key only belongs to the provider it was saved for. */
const keySavedForThis = computed(() => !!ai.value?.has_key && ai.value.provider === aiForm.value?.provider && !aiForm.value?.removeKey);
const aiPayload = (): { provider: Provider; model: string | null; api_key?: string | null } => {
  const f = aiForm.value!;
  return {
    provider: f.provider,
    model: f.provider === 'simulator' ? null : f.model.trim() || null,
    ...(f.api_key.trim() ? { api_key: f.api_key.trim() } : f.removeKey || f.provider === 'simulator' ? { api_key: null } : {}),
  };
};
async function testAi() {
  aiTest.value = null;
  busy.value = 'ai-test';
  try {
    const body = aiPayload();
    const r = await api.post<{ model: string; automatic: boolean; busy_skipped: string[]; latency_ms: number }>('/admin/ai/test', {
      provider: body.provider,
      model: body.model,
      ...(body.api_key ? { api_key: body.api_key } : {}),
    });
    const seconds = (r.latency_ms / 1000).toFixed(1);
    const skipped = r.busy_skipped.length ? ` (${r.busy_skipped.join(', ')} ${r.busy_skipped.length === 1 ? 'was' : 'were'} busy)` : '';
    aiTest.value = {
      ok: true,
      text: r.automatic ? `Connected — automatic picked ${r.model}${skipped} · answered in ${seconds} s` : `Connected to ${r.model} · answered in ${seconds} s`,
    };
    if (!models.value.length) void loadModels();
  } catch (err) {
    aiTest.value = { ok: false, text: errorMessage(err) };
  } finally {
    busy.value = null;
  }
}
const saveAi = () =>
  act('ai-save', async () => {
    await api.put('/admin/ai', aiPayload());
    aiForm.value = null;
  }, 'AI settings saved');

const retryEvent = (id: string) => act(id, () => api.post(`/admin/events/${id}/retry`), 'Retry queued');
const retryDelivery = (id: string) => act(id, () => api.post(`/admin/deliveries/${id}/retry`), 'Retry queued');

const STATUS_TONE: Record<string, Tone> = { pending: 'neutral', dispatched: 'info', queued: 'info', completed: 'ok', sent: 'ok', simulated: 'warn', skipped: 'neutral', failed: 'bad', dead: 'bad' };
const failedEvents = computed(() => data.value?.events.filter((e) => e.status === 'failed' || e.status === 'dead') ?? []);
const overviewGroups = computed(() => {
  const groups = new Map<string, { status: string; count: number }[]>();
  for (const r of data.value?.overview ?? []) groups.set(r.department_name, [...(groups.get(r.department_name) ?? []), r]);
  return [...groups];
});
const counts = (rows: { status: string; count: number }[]) => rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + r.count), acc), {});
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader title="Integrations" description="What is connected, what is simulated, and every automation run. Report content is not shown here.">
      <UiButton :loading="busy === 'tick'" @click="runTick">Run scheduled checks</UiButton>
    </PageHeader>

    <StateBlock :loading="loading" :error="error" :lines="6" @retry="reload()">
      <template v-if="data">
        <div class="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card flex flex-col p-4">
            <p class="eyebrow">AI processing</p>
            <p class="mt-1.5 text-[15px] font-medium">{{ aiTitle }}</p>
            <p class="mt-0.5 text-[13px]" :class="data.adapters.ai.simulated ? 'text-warn' : 'text-ink-2'">
              {{ data.adapters.ai.simulated ? 'No AI provider is called yet.' : data.adapters.ai.model ? `Model ${data.adapters.ai.model}` : data.adapters.ai.webhook_configured ? 'Webhook configured' : 'Webhook missing' }}
            </p>
            <p class="mt-2 text-[12.5px] text-ink-3">Prompt v{{ data.adapters.ai.prompt_version }}</p>
            <UiButton v-if="data.adapters.ai.adapter === 'admin'" class="mt-3 self-start" size="sm" :variant="data.adapters.ai.simulated ? 'primary' : 'secondary'" @click="openAi">
              {{ data.adapters.ai.simulated ? 'Connect an AI' : 'Change AI settings' }}
            </UiButton>
          </div>
          <div class="card p-4">
            <p class="eyebrow">Email</p>
            <p class="mt-1.5 text-[15px] font-medium capitalize">{{ data.adapters.email.simulated ? 'Dev outbox' : data.adapters.email.transport }}</p>
            <p class="mt-0.5 text-[13px]" :class="data.adapters.email.simulated ? 'text-warn' : 'text-ink-2'">
              {{ data.adapters.email.simulated ? 'Recorded only. Nothing is sent.' : `From ${data.adapters.email.from}` }}
            </p>
          </div>
          <div class="card p-4">
            <p class="eyebrow">SMS</p>
            <p class="mt-1.5 text-[15px] font-medium">{{ data.adapters.sms.connected ? 'n8n workflow' : 'Not connected' }}</p>
            <p class="mt-0.5 text-[13px]" :class="data.adapters.sms.connected ? 'text-ink-2' : 'text-ink-3'">{{ data.adapters.sms.note }}</p>
            <p v-if="data.adapters.sms.connected" class="mt-2 text-[12.5px] text-ink-3">Sender: {{ data.adapters.sms.from }}</p>
          </div>
          <div class="card p-4">
            <p class="eyebrow">n8n callbacks</p>
            <p class="mt-1.5 text-[15px] font-medium">{{ data.adapters.callbacks.enabled ? 'Enabled' : 'Disabled' }}</p>
            <p class="mt-0.5 text-[13px] text-ink-2">Scheduler: {{ data.adapters.scheduler.internal ? `internal, every ${Math.round(data.adapters.scheduler.interval_ms / 1000)}s` : 'external (n8n cron)' }}</p>
          </div>
        </div>

        <div class="mt-6 grid gap-4 lg:grid-cols-2">
          <section class="card p-5">
            <h2 class="text-[15px] font-semibold">Automation events · 7 days</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <StatusBadge v-for="(n, s) in counts(data.eventCounts)" :key="s" :tone="STATUS_TONE[s] ?? 'neutral'"><span class="capitalize">{{ s }}</span> <span class="tnum">{{ n }}</span></StatusBadge>
              <p v-if="!data.eventCounts.length" class="text-[13px] text-ink-3">None yet.</p>
            </div>
          </section>
          <section class="card p-5">
            <h2 class="text-[15px] font-semibold">Notification deliveries · 7 days</h2>
            <div class="mt-3 flex flex-wrap gap-2">
              <StatusBadge v-for="(n, s) in counts(data.deliveryCounts)" :key="s" :tone="STATUS_TONE[s] ?? 'neutral'"><span class="capitalize">{{ s }}</span> <span class="tnum">{{ n }}</span></StatusBadge>
              <p v-if="!data.deliveryCounts.length" class="text-[13px] text-ink-3">None yet.</p>
            </div>
          </section>
        </div>

        <section v-if="failedEvents.length" class="mt-6">
          <h2 class="mb-2 text-[15px] font-semibold text-bad">Failed automation</h2>
          <ul class="stagger card divide-y divide-line">
            <li v-for="e in failedEvents" :key="e.id" class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div class="min-w-0">
                <p class="text-[14px] font-medium">{{ e.kind.replace('_', ' ') }} <span class="font-normal text-ink-3">· {{ e.department_name }} · attempt {{ e.attempts }}/{{ e.max_attempts }}</span></p>
                <p class="truncate text-[13px] text-bad">{{ e.last_error }}</p>
              </div>
              <UiButton size="sm" :loading="busy === e.id" @click="retryEvent(e.id)">Retry</UiButton>
            </li>
          </ul>
        </section>

        <section class="mt-6">
          <h2 class="mb-2 text-[15px] font-semibold">Recent automation events</h2>
          <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Automation events and deliveries — scroll horizontally to see all columns">
            <table class="w-full min-w-[640px] text-left text-[13.5px]">
              <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                <tr><th class="px-4 py-2.5 font-medium">Created</th><th class="px-3 py-2.5 font-medium">Kind</th><th class="px-3 py-2.5 font-medium">Adapter</th><th class="px-3 py-2.5 font-medium">Attempts</th><th class="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody class="stagger divide-y divide-line">
                <tr v-for="e in data.events" :key="e.id">
                  <td class="px-4 py-2 text-ink-3 tnum">{{ dateTime(e.created_at) }}</td>
                  <td class="px-3 py-2">{{ e.kind.replace('_', ' ') }}<span class="block text-[12px] text-ink-3">{{ e.department_name }}</span></td>
                  <td class="px-3 py-2 text-ink-2">{{ e.adapter ?? '—' }}</td>
                  <td class="px-3 py-2 tnum">{{ e.attempts }}/{{ e.max_attempts }}</td>
                  <td class="px-4 py-2"><StatusBadge :tone="STATUS_TONE[e.status] ?? 'neutral'" :label="e.status" class="capitalize" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="mt-6">
          <h2 class="mb-2 text-[15px] font-semibold">Recent deliveries</h2>
          <StateBlock :empty="!data.deliveries.length" empty-title="No deliveries yet">
            <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Automation events and deliveries — scroll horizontally to see all columns">
              <table class="w-full min-w-[640px] text-left text-[13.5px]">
                <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                  <tr><th class="px-4 py-2.5 font-medium">Created</th><th class="px-3 py-2.5 font-medium">Recipient</th><th class="px-3 py-2.5 font-medium">Channel</th><th class="px-3 py-2.5 font-medium">Provider</th><th class="px-4 py-2.5 font-medium">Status</th></tr>
                </thead>
                <tbody class="stagger divide-y divide-line">
                  <tr v-for="d in data.deliveries" :key="d.id">
                    <td class="px-4 py-2 text-ink-3 tnum">{{ dateTime(d.created_at) }}</td>
                    <td class="px-3 py-2">{{ d.recipient_name }}</td>
                    <td class="px-3 py-2 uppercase">{{ d.channel }}</td>
                    <td class="px-3 py-2 text-ink-2">{{ d.provider ?? '—' }}<span v-if="d.last_error" class="block max-w-xs truncate text-[12px] text-bad">{{ d.last_error }}</span></td>
                    <td class="px-4 py-2">
                      <div class="flex items-center gap-2">
                        <StatusBadge :tone="STATUS_TONE[d.status] ?? 'neutral'" :label="d.status" class="capitalize" />
                        <button v-if="d.status === 'failed' && d.attempts >= d.max_attempts" class="text-[12.5px] link" @click="retryDelivery(d.id)">Retry</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </StateBlock>
        </section>

        <section v-if="data.adapters.email.simulated" class="mt-6">
          <h2 class="text-[15px] font-semibold">Dev outbox</h2>
          <p class="mb-2 text-[13px] text-ink-3">What would have been emailed. Nothing here left this machine.</p>
          <StateBlock :empty="!data.outbox.length" empty-title="Empty">
            <ul class="stagger card divide-y divide-line">
              <li v-for="o in data.outbox" :key="o.id" class="px-5 py-3">
                <p class="flex flex-wrap justify-between gap-2 text-[13.5px]"><span class="font-medium">{{ o.provider_response?.subject }}</span><span class="text-ink-3">to {{ o.address }} · {{ relative(o.updated_at) }}</span></p>
                <pre class="mt-1 text-[12.5px] whitespace-pre-wrap text-ink-2 font-sans">{{ o.provider_response?.preview }}</pre>
              </li>
            </ul>
          </StateBlock>
        </section>

        <section v-if="data.overview?.length" class="mt-6">
          <h2 class="mb-2 text-[15px] font-semibold">Reports by status · 14 days</h2>
          <p class="mb-2 text-[13px] text-ink-3">Counts only. Administrators cannot open report content.</p>
          <div class="card divide-y divide-line">
            <div v-for="[dept, group] in overviewGroups" :key="dept" class="flex flex-wrap items-center gap-2 px-5 py-3">
              <span class="mr-2 text-[14px] font-medium">{{ dept }}</span>
              <StatusBadge v-for="r in group" :key="r.status" :report="r.status as never"><span class="capitalize">{{ r.status.replace('_', ' ') }}</span> <span class="tnum">{{ r.count }}</span></StatusBadge>
            </div>
          </div>
        </section>
      </template>
    </StateBlock>

    <section v-if="auth.config?.demo" class="card mt-8 flex flex-col gap-3 border-bad/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Reset activity">
      <div>
        <p class="text-[14px] font-semibold">Reset all activity</p>
        <p class="text-[13px] text-ink-3">Removes every shift, report, ticket, notification and source record. Accounts, departments and shift patterns stay. Local mode only.</p>
      </div>
      <UiButton variant="danger" :loading="busy === 'clear'" @click="confirmClear = true">Reset activity</UiButton>
    </section>
    <UiDialog
      :open="Boolean(aiForm)"
      title="AI provider"
      description="The AI that drafts each handover from the sanitized report. A supervisor still checks and approves every draft."
      @close="aiForm = null"
    >
      <form v-if="aiForm && ai" id="ai-form" class="space-y-4" @submit.prevent="saveAi">
        <fieldset>
          <legend class="mb-1.5 text-[13.5px] font-medium">Provider</legend>
          <div class="grid gap-2 sm:grid-cols-3">
            <label
              v-for="p in ([['gemini', 'Google Gemini'], ['grok', 'xAI Grok'], ['simulator', 'Simulator (no AI)']] as const)"
              :key="p[0]"
              class="cursor-pointer rounded-md border px-3 py-2.5 text-[13.5px] transition"
              :class="aiForm.provider === p[0] ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:border-line-strong'"
            >
              <input v-model="aiForm.provider" type="radio" :value="p[0]" class="sr-only" @change="(aiForm.model = ''), (aiTest = null), (aiForm.removeKey = false), (models = []), (suggestedModel = null), (modelsError = null)" />
              {{ p[1] }}
            </label>
          </div>
          <p class="mt-2 text-[12.5px] text-ink-3">{{ PROVIDER_NOTE[aiForm.provider] }}</p>
        </fieldset>

        <template v-if="providerInfo">
          <UiField v-slot="{ id }" label="API key" :hint="keySavedForThis ? `Saved key ends with …${ai.key_hint}. Leave empty to keep it.` : undefined">
            <div class="relative">
              <input
                :id="id"
                v-model="aiForm.api_key"
                :type="showKey ? 'text' : 'password'"
                class="field-input pr-16 font-mono text-[13px]"
                autocomplete="off"
                spellcheck="false"
                :placeholder="keySavedForThis ? '•••••••••••• (saved)' : 'Paste the key'"
              />
              <button type="button" class="absolute inset-y-0 right-0 px-3 text-[12.5px] font-medium text-ink-3 hover:text-ink" @click="showKey = !showKey">{{ showKey ? 'Hide' : 'Show' }}</button>
            </div>
          </UiField>
          <p class="-mt-2 text-[12.5px] text-ink-3">
            Get one at <a :href="providerInfo.keyUrl" target="_blank" rel="noopener noreferrer" class="link">{{ providerInfo.keyUrl.replace('https://', '') }}</a>.
            It is encrypted before it is stored and never shown again.
          </p>
          <UiField v-slot="{ id }" label="Model" optional>
            <div class="flex gap-2">
              <input
                :id="id"
                v-model="aiForm.model"
                class="field-input font-mono text-[13px]"
                list="ai-models"
                :placeholder="suggestedModel ? `Automatic (now ${suggestedModel})` : 'Automatic — newest available'"
                spellcheck="false"
                autocomplete="off"
              />
              <UiButton size="sm" variant="ghost" class="h-auto shrink-0" :loading="busy === 'ai-models'" :disabled="!aiForm.api_key.trim() && !keySavedForThis" @click="loadModels">
                {{ models.length ? 'Refresh' : 'Show models' }}
              </UiButton>
            </div>
            <datalist id="ai-models">
              <option v-for="m in models" :key="m" :value="m" />
            </datalist>
          </UiField>
          <p class="-mt-2 text-[12.5px] text-ink-3">
            Leave empty to always use the newest model your key can use — it keeps working when the provider retires an old one.
            <template v-if="models.length"> {{ models.length }} available; click the box to pick one.</template>
          </p>
          <p v-if="modelsError" class="-mt-2 text-[12.5px] text-bad">{{ modelsError }}</p>
          <label v-if="keySavedForThis || (ai.has_key && ai.provider === aiForm.provider)" class="flex items-center gap-2 text-[13px] text-ink-2">
            <input v-model="aiForm.removeKey" type="checkbox" class="size-4 accent-accent" /> Remove the saved key
          </label>
          <div class="flex flex-wrap items-center gap-3">
            <UiButton size="sm" :loading="busy === 'ai-test'" :disabled="!aiForm.api_key.trim() && !keySavedForThis" @click="testAi">Test connection</UiButton>
            <p v-if="aiTest" class="text-[13px]" :class="aiTest.ok ? 'text-ok' : 'text-bad'" role="status">{{ aiTest.text }}</p>
          </div>
          <p v-if="!ai.encryption_available" class="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">
            The server has no SECRETS_ENCRYPTION_KEY, so it cannot store a key yet.
          </p>
        </template>
        <p v-if="ai.updated_at && ai.updated_by_name" class="text-[12px] text-ink-3">Last changed by {{ ai.updated_by_name }}, {{ dateTime(ai.updated_at) }}</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="aiForm = null">Cancel</UiButton>
        <UiButton
          variant="primary"
          type="submit"
          form="ai-form"
          :loading="busy === 'ai-save'"
          :disabled="!!aiForm && aiForm.provider !== 'simulator' && !aiForm.api_key.trim() && !keySavedForThis"
        >
          Save
        </UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="confirmClear" title="Reset all activity?" description="This permanently removes every shift, report, handover, ticket and notification." @close="confirmClear = false">
      <p class="text-[13.5px] text-ink-2">Accounts, departments, shift patterns and the audit log are kept.</p>
      <template #footer>
        <UiButton variant="ghost" @click="confirmClear = false">Cancel</UiButton>
        <UiButton variant="danger" :loading="busy === 'clear'" @click="resetAll">Reset everything</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
