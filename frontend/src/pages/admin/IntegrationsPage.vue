<script setup lang="ts">
import { IonCheckbox, IonChip, IonContent, IonInput, IonInputPasswordToggle, IonLabel, IonPage, IonSegment, IonSegmentButton } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge, { type Tone } from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { dateTime, relative } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Integrations {
  adapters: {
    ai: { adapter: 'dev' | 'n8n' | 'admin'; provider: 'gemini' | 'grok' | null; model: string | null; simulated: boolean; webhook_configured: boolean; prompt_version: string };
    email: { transport: string; simulated: boolean; from: string; provider: 'none' | 'gmail' | 'resend' };
    sms: { connected: boolean; transport: 'none' | 'n8n'; webhook_configured: boolean; from: string; note: string };
    callbacks: { enabled: boolean };
    scheduler: { internal: boolean; interval_ms: number };
  };
  eventCounts: { kind: string; status: string; count: number }[];
  events: { id: string; kind: string; status: string; adapter: string | null; attempts: number; max_attempts: number; last_error: string | null; created_at: string; department_name: string | null; next_attempt_at: string; superseded: boolean }[];
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
    toast.info(`Removed ${r.cleared.shifts} shifts, ${r.cleared.reports} endorsements and ${r.cleared.issues} concerns`);
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
  return ai.adapter === 'n8n' && !ai.simulated ? 'n8n workflow' : 'Mica practice simulator';
});
// n8n is optional and not part of this setup: its card shows only when it is actually in use.
const showN8n = computed(() => {
  const a = data.value?.adapters;
  return !!a && (a.ai.adapter === 'n8n' || a.sms.connected || a.callbacks.enabled);
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

// ---- Email sender: Gmail (free, with an App Password) or Resend. Stored encrypted, never shown again.
type EmailProvider = 'none' | 'gmail' | 'resend';
interface EmailSettingsView {
  provider: EmailProvider;
  from_name: string | null;
  from_address: string | null;
  has_secret: boolean;
  secret_hint: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  encryption_available: boolean;
  active: string;
  simulated: boolean;
  providers: { id: 'gmail' | 'resend'; label: string; secret_label: string; note: string; secret_url: string }[];
}
const mail = ref<EmailSettingsView | null>(null);
const mailForm = ref<{ provider: EmailProvider; from_name: string; from_address: string; secret: string; test_to: string } | null>(null);
const mailTest = ref<{ ok: boolean; text: string } | null>(null);
const mailErrors = ref<Record<string, string>>({});
const showSecret = ref(false);
async function openMail() {
  try {
    mail.value = await api.get<EmailSettingsView>('/admin/email');
    const m = mail.value;
    mailForm.value = {
      provider: m.provider === 'none' ? 'gmail' : m.provider,
      from_name: m.from_name ?? 'Silent Handover',
      from_address: m.from_address ?? '',
      secret: '',
      test_to: m.from_address ?? '',
    };
    mailTest.value = null;
    mailErrors.value = {};
    showSecret.value = false;
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
const mailProvider = computed(() => mail.value?.providers.find((p) => p.id === mailForm.value?.provider) ?? null);
const secretSavedForThis = computed(() => !!mail.value?.has_secret && mail.value.provider === mailForm.value?.provider);
const mailPayload = () => {
  const f = mailForm.value!;
  return {
    provider: f.provider,
    from_name: f.from_name.trim() || null,
    from_address: f.from_address.trim() || null,
    ...(f.secret.trim() ? { secret: f.secret.trim() } : {}),
  };
};
function fieldErrors(err: unknown) {
  mailErrors.value = err instanceof ApiError ? err.fields : {};
}
async function testMail() {
  mailTest.value = null;
  mailErrors.value = {};
  busy.value = 'mail-test';
  try {
    const r = await api.post<{ ok: boolean; latency_ms: number; error: string | null }>('/admin/email/test', { ...mailPayload(), to: mailForm.value!.test_to.trim() });
    mailTest.value = r.ok
      ? { ok: true, text: `Sent in ${(r.latency_ms / 1000).toFixed(1)} s. Check the inbox (and Spam) of ${mailForm.value!.test_to.trim()}.` }
      : { ok: false, text: r.error ?? 'The email could not be sent.' };
  } catch (err) {
    fieldErrors(err);
    mailTest.value = { ok: false, text: errorMessage(err) };
  } finally {
    busy.value = null;
  }
}
async function saveMail() {
  mailErrors.value = {};
  busy.value = 'mail-save';
  try {
    await api.put('/admin/email', mailPayload());
    mailForm.value = null;
    toast.ok('Email sending is on');
    await reload(true);
  } catch (err) {
    fieldErrors(err);
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
const confirmMailOff = ref(false);
const turnMailOff = () =>
  act('mail-off', async () => {
    await api.put('/admin/email', { provider: 'none' });
    confirmMailOff.value = false;
    mailForm.value = null;
  }, 'Email sending turned off');

const retryEvent = (id: string) => act(id, () => api.post(`/admin/events/${id}/retry`), 'Retry queued');
const retryDelivery = (id: string) => act(id, () => api.post(`/admin/deliveries/${id}/retry`), 'Retry queued');

const STATUS_TONE: Record<string, Tone> = { pending: 'neutral', dispatched: 'info', queued: 'info', completed: 'ok', sent: 'ok', simulated: 'warn', skipped: 'neutral', failed: 'bad', dead: 'bad' };
const failedEvents = computed(() => data.value?.events.filter((e) => (e.status === 'failed' || e.status === 'dead') && !e.superseded) ?? []);
const overviewGroups = computed(() => {
  const groups = new Map<string, { status: string; count: number }[]>();
  for (const r of data.value?.overview ?? []) groups.set(r.department_name, [...(groups.get(r.department_name) ?? []), r]);
  return [...groups];
});
const counts = (rows: { status: string; count: number }[]) => rows.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + r.count), acc), {});
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-5xl">
            <PageHeader title="Integrations" description="What is connected, what is simulated, and every automation run. Endorsement content is not shown here.">
              <UiButton :loading="busy === 'tick'" @click="runTick">Run scheduled checks</UiButton>
            </PageHeader>

            <StateBlock :loading="loading" :error="error" :lines="6" @retry="reload()">
              <template v-if="data">
                <div class="stagger grid gap-4 sm:grid-cols-2" :class="showN8n ? 'lg:grid-cols-4' : 'lg:grid-cols-3'">
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
                  <div class="card flex flex-col p-4">
                    <p class="eyebrow">Email</p>
                    <p class="mt-1.5 flex items-center gap-2 text-[15px] font-medium">
                      {{ data.adapters.email.simulated ? 'Not sending yet' : data.adapters.email.transport === 'gmail' ? 'Gmail' : data.adapters.email.transport === 'resend' ? 'Resend' : 'n8n workflow' }}
                      <StatusBadge :tone="data.adapters.email.simulated ? 'warn' : 'ok'" :label="data.adapters.email.simulated ? 'Off' : 'Sending'" />
                    </p>
                    <p class="mt-0.5 text-[13px] text-ink-2">
                      {{ data.adapters.email.simulated ? 'Invitations and notifications are not emailed. Connect Gmail so new users get their invitation.' : `From ${data.adapters.email.from}` }}
                    </p>
                    <UiButton class="mt-3 self-start" size="sm" :variant="data.adapters.email.simulated ? 'primary' : 'secondary'" @click="openMail">
                      {{ data.adapters.email.simulated ? 'Connect email' : 'Change email settings' }}
                    </UiButton>
                  </div>
                  <div class="card p-4">
                    <p class="eyebrow">SMS</p>
                    <p class="mt-1.5 flex items-center gap-2 text-[15px] font-medium">{{ data.adapters.sms.connected ? 'n8n workflow' : 'Not set up' }}<StatusBadge v-if="!data.adapters.sms.connected" tone="neutral" label="Coming soon" /></p>
                    <p class="mt-0.5 text-[13px] text-ink-2">{{ data.adapters.sms.connected ? data.adapters.sms.note : 'Text-message alerts are planned. Nothing is sent by SMS.' }}</p>
                    <p v-if="data.adapters.sms.connected" class="mt-2 text-[12.5px] text-ink-3">Sender: {{ data.adapters.sms.from }}</p>
                  </div>
                  <div v-if="showN8n" class="card p-4">
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
                          <td class="px-4 py-2"><StatusBadge :tone="e.superseded ? 'neutral' : (STATUS_TONE[e.status] ?? 'neutral')" :label="e.superseded ? 'Failed, then retried' : e.status" class="capitalize" /></td>
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
                                <UiButton v-if="d.status === 'failed' && d.attempts >= d.max_attempts" size="sm" variant="ghost" @click="retryDelivery(d.id)">Retry</UiButton>
                              </div>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </StateBlock>
                </section>

                <section v-if="data.adapters.email.simulated" class="mt-6">
                  <h2 class="text-[15px] font-semibold">Email previews</h2>
                  <p class="mb-2 text-[13px] text-ink-3">What would be emailed once email sending is connected. Nothing here has been sent.</p>
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
                  <h2 class="mb-2 text-[15px] font-semibold">Shift endorsements by status · 14 days</h2>
                  <p class="mb-2 text-[13px] text-ink-3">Counts only. Administrators cannot open endorsement content.</p>
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
                <p class="text-[13px] text-ink-3">Removes every shift, endorsement, concern, notification and unit record. Accounts, departments and shift patterns stay. Local mode only.</p>
              </div>
              <UiButton variant="danger" :loading="busy === 'clear'" @click="confirmClear = true">Reset activity</UiButton>
            </section>
            <UiDialog
              :open="Boolean(aiForm)"
              title="AI provider"
              description="The AI that drafts each shift endorsement from the sanitized submission. A department head still checks and approves every draft."
              @close="aiForm = null"
            >
              <form v-if="aiForm && ai" id="ai-form" class="space-y-4" @submit.prevent="saveAi">
                <fieldset>
                  <legend class="mb-1.5 text-[13.5px] font-medium">Provider</legend>
                  <IonSegment
                    v-model="aiForm.provider"
                    aria-label="AI provider"
                    @ion-change="(aiForm.model = ''), (aiTest = null), (aiForm.removeKey = false), (models = []), (suggestedModel = null), (modelsError = null)"
                  >
                    <IonSegmentButton v-for="p in ([['gemini', 'Google Gemini'], ['grok', 'xAI Grok'], ['simulator', 'Practice simulator (no AI)']] as const)" :key="p[0]" :value="p[0]">
                      <IonLabel class="text-[13px] normal-case">{{ p[1] }}</IonLabel>
                    </IonSegmentButton>
                  </IonSegment>
                  <p class="mt-2 text-[12.5px] text-ink-3">{{ PROVIDER_NOTE[aiForm.provider] }}</p>
                </fieldset>

                <template v-if="providerInfo">
                  <UiField v-slot="{ id, labelledby }" label="API key" :hint="keySavedForThis ? `Saved key ends with …${ai.key_hint}. Leave empty to keep it.` : undefined">
                    <div class="relative">
                      <IonInput
                        :id="id" :aria-labelledby="labelledby"
                        v-model="aiForm.api_key"
                        type="password"
                        class="field-input pr-16 font-mono text-[13px]"
                        autocomplete="off"
                        :spellcheck="false"
                        :placeholder="keySavedForThis ? '•••••••••••• (saved)' : 'Paste the key'"><IonInputPasswordToggle slot="end" color="medium" /></IonInput>
                    </div>
                  </UiField>
                  <p class="-mt-2 text-[12.5px] text-ink-3">
                    Get one at <a :href="providerInfo.keyUrl" target="_blank" rel="noopener noreferrer" class="link">{{ providerInfo.keyUrl.replace('https://', '') }}</a>.
                    It is encrypted before it is stored and never shown again.
                  </p>
                  <UiField v-slot="{ id, labelledby }" label="Model" optional>
                    <div class="flex gap-2">
                      <IonInput
                        :id="id" :aria-labelledby="labelledby"
                        v-model="aiForm.model"
                        class="field-input font-mono text-[13px]"
                        :placeholder="suggestedModel ? `Automatic (now ${suggestedModel})` : 'Automatic — newest available'"
                        :spellcheck="false"
                        autocomplete="off"
                       />
                      <UiButton size="sm" variant="ghost" class="h-auto shrink-0" :loading="busy === 'ai-models'" :disabled="!aiForm.api_key.trim() && !keySavedForThis" @click="loadModels">
                        {{ models.length ? 'Refresh' : 'Show models' }}
                      </UiButton>
                    </div>
                    <div v-if="models.length" class="flex flex-wrap gap-1.5" aria-label="Models this key can use">
                      <IonChip v-for="m in models" :key="m" :outline="aiForm.model !== m" :color="aiForm.model === m ? 'primary' : undefined" class="m-0 font-mono text-[12px]" @click="aiForm.model = m">{{ m }}</IonChip>
                    </div>
                  </UiField>
                  <p class="-mt-2 text-[12.5px] text-ink-3">
                    Leave empty to always use the newest model your key can use — it keeps working when the provider retires an old one.
                    <template v-if="models.length"> {{ models.length }} available; click the box to pick one.</template>
                  </p>
                  <p v-if="modelsError" class="-mt-2 text-[12.5px] text-bad">{{ modelsError }}</p>
                  <IonCheckbox v-if="keySavedForThis || (ai.has_key && ai.provider === aiForm.provider)" class="flex items-center gap-2 text-[13px] text-ink-2" v-model="aiForm.removeKey" label-placement="end" justify="start">Remove the saved key</IonCheckbox>
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

            <UiDialog
              :open="Boolean(mailForm)"
              title="Email sending"
              description="Sends account invitations, password reset links and endorsement notifications. Endorsement content is never put in an email."
              @close="mailForm = null"
            >
              <form v-if="mailForm && mail" id="mail-form" class="space-y-4" @submit.prevent="saveMail">
                <fieldset>
                  <legend class="mb-1.5 text-[13.5px] font-medium">Send with</legend>
                  <IonSegment v-model="mailForm.provider" aria-label="Send with" @ion-change="(mailForm.secret = ''), (mailTest = null), (mailErrors = {})">
                    <IonSegmentButton v-for="p in mail.providers" :key="p.id" :value="p.id">
                      <IonLabel class="text-[13px] normal-case">{{ p.label }}<span v-if="p.id === 'gmail'" class="text-ink-3"> · free, recommended</span></IonLabel>
                    </IonSegmentButton>
                  </IonSegment>
                  <p v-if="mailProvider" class="mt-2 text-[12.5px] text-ink-3">{{ mailProvider.note }}</p>
                </fieldset>

                <ol v-if="mailForm.provider === 'gmail'" class="list-decimal space-y-1 rounded-md bg-canvas py-2.5 pr-3 pl-8 text-[12.5px] text-ink-2">
                  <li>Sign in to the Gmail account that will send the emails.</li>
                  <li>Turn on <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer" class="link">2-Step Verification</a>.</li>
                  <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" class="link">App passwords</a>, name it “Silent Handover” and copy the 16 letters.</li>
                  <li>Paste them below, send a test, then save.</li>
                </ol>

                <div class="grid gap-3 sm:grid-cols-2">
                  <UiField v-slot="{ id, labelledby }" :label="mailForm.provider === 'gmail' ? 'Gmail address' : 'From address'" :error="mailErrors.from_address">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="mailForm.from_address" type="email" class="field-input" autocomplete="off" :placeholder="mailForm.provider === 'gmail' ? 'yourteam@gmail.com' : 'notifications@yourhospital.ph'" @ion-input="!mailForm.test_to && (mailForm.test_to = mailForm.from_address)"  />
                  </UiField>
                  <UiField v-slot="{ id, labelledby }" label="Sender name" :error="mailErrors.from_name">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="mailForm.from_name" class="field-input" :maxlength="80"  />
                  </UiField>
                </div>
                <UiField v-if="mailProvider" v-slot="{ id, labelledby }" :label="mailProvider.secret_label" :error="mailErrors.secret" :hint="secretSavedForThis ? `Saved one ends with …${mail.secret_hint}. Leave empty to keep it.` : 'Encrypted before it is stored and never shown again.'">
                  <div class="relative">
                    <IonInput
                      :id="id" :aria-labelledby="labelledby"
                      v-model="mailForm.secret"
                      type="password"
                      class="field-input pr-16 font-mono text-[13px]"
                      autocomplete="new-password"
                      :spellcheck="false"
                      :placeholder="secretSavedForThis ? '•••••••••••• (saved)' : mailForm.provider === 'gmail' ? 'abcd efgh ijkl mnop' : 're_…'"><IonInputPasswordToggle slot="end" color="medium" /></IonInput>
                  </div>
                </UiField>

                <div class="rounded-md border border-line p-3">
                  <UiField v-slot="{ id, labelledby }" label="Send a test to">
                    <div class="flex gap-2">
                      <IonInput :id="id" :aria-labelledby="labelledby" v-model="mailForm.test_to" type="email" class="field-input" autocomplete="off" placeholder="you@example.com"  />
                      <UiButton size="sm" class="h-auto shrink-0" :loading="busy === 'mail-test'" :disabled="!mailForm.test_to.trim() || !mailForm.from_address.trim() || (!mailForm.secret.trim() && !secretSavedForThis)" @click="testMail">Send test</UiButton>
                    </div>
                  </UiField>
                  <p v-if="mailTest" class="mt-2 text-[13px]" :class="mailTest.ok ? 'text-ok' : 'text-bad'" role="status">{{ mailTest.text }}</p>
                </div>
                <p v-if="!mail.encryption_available" class="rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">
                  The server has no SECRETS_ENCRYPTION_KEY, so it cannot store a password or key yet.
                </p>
                <p v-if="mail.updated_at && mail.updated_by_name" class="text-[12px] text-ink-3">Last changed by {{ mail.updated_by_name }}, {{ dateTime(mail.updated_at) }}</p>
              </form>
              <template #footer>
                <UiButton v-if="mail && mail.provider !== 'none'" variant="ghost" class="mr-auto text-bad" @click="confirmMailOff = true">Turn off</UiButton>
                <UiButton variant="ghost" @click="mailForm = null">Cancel</UiButton>
                <UiButton
                  variant="primary"
                  type="submit"
                  form="mail-form"
                  :loading="busy === 'mail-save'"
                  :disabled="!!mailForm && (!mailForm.from_address.trim() || (!mailForm.secret.trim() && !secretSavedForThis))"
                >
                  Save
                </UiButton>
              </template>
            </UiDialog>

            <UiDialog :open="confirmMailOff" title="Turn off email sending?" description="The saved password or key is deleted. Invitations will no longer be emailed; you would copy each link yourself." @close="confirmMailOff = false">
              <template #footer>
                <UiButton variant="ghost" @click="confirmMailOff = false">Cancel</UiButton>
                <UiButton variant="danger" :loading="busy === 'mail-off'" @click="turnMailOff">Turn off</UiButton>
              </template>
            </UiDialog>

            <UiDialog :open="confirmClear" title="Reset all activity?" description="This permanently removes every shift, endorsement, concern and notification." @close="confirmClear = false">
              <p class="text-[13.5px] text-ink-2">Accounts, departments, shift patterns and the audit log are kept.</p>
              <template #footer>
                <UiButton variant="ghost" @click="confirmClear = false">Cancel</UiButton>
                <UiButton variant="danger" :loading="busy === 'clear'" @click="resetAll">Reset everything</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
