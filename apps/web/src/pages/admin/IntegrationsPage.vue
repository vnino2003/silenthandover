<script setup lang="ts">
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge, { type Tone } from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, relative } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Integrations {
  adapters: {
    ai: { adapter: 'dev' | 'n8n'; simulated: boolean; webhook_configured: boolean; prompt_version: string };
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
const clearDemo = () =>
  act('clear', async () => {
    const r = await api.post<{ cleared: { shifts: number; reports: number; issues: number } }>('/admin/demo/clear', { confirm: 'CLEAR' });
    confirmClear.value = false;
    toast.info(`Removed ${r.cleared.shifts} shifts, ${r.cleared.reports} reports and ${r.cleared.issues} tickets`);
  }, 'Demo data cleared');

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
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card p-4">
            <p class="eyebrow">AI processing</p>
            <p class="mt-1.5 text-[15px] font-medium">{{ data.adapters.ai.simulated ? 'Development simulator' : 'n8n workflow' }}</p>
            <p class="mt-0.5 text-[13px]" :class="data.adapters.ai.simulated ? 'text-warn' : 'text-ink-2'">
              {{ data.adapters.ai.simulated ? 'No AI provider is called.' : data.adapters.ai.webhook_configured ? 'Webhook configured' : 'Webhook missing' }}
            </p>
            <p class="mt-2 text-[12.5px] text-ink-3">Prompt v{{ data.adapters.ai.prompt_version }}</p>
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
          <ul class="card divide-y divide-line">
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
          <div class="card overflow-x-auto">
            <table class="w-full min-w-[640px] text-left text-[13.5px]">
              <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                <tr><th class="px-4 py-2.5 font-medium">Created</th><th class="px-3 py-2.5 font-medium">Kind</th><th class="px-3 py-2.5 font-medium">Adapter</th><th class="px-3 py-2.5 font-medium">Attempts</th><th class="px-4 py-2.5 font-medium">Status</th></tr>
              </thead>
              <tbody class="divide-y divide-line">
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
            <div class="card overflow-x-auto">
              <table class="w-full min-w-[640px] text-left text-[13.5px]">
                <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                  <tr><th class="px-4 py-2.5 font-medium">Created</th><th class="px-3 py-2.5 font-medium">Recipient</th><th class="px-3 py-2.5 font-medium">Channel</th><th class="px-3 py-2.5 font-medium">Provider</th><th class="px-4 py-2.5 font-medium">Status</th></tr>
                </thead>
                <tbody class="divide-y divide-line">
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
            <ul class="card divide-y divide-line">
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

    <section v-if="auth.config?.demo" class="card mt-8 flex flex-col gap-3 border-bad/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Demo data">
      <div>
        <p class="text-[14px] font-semibold">Start the demo over</p>
        <p class="text-[13px] text-ink-3">Removes every shift, report, ticket and notification. Accounts, departments and shift patterns stay. Local demo only.</p>
      </div>
      <UiButton variant="danger" :loading="busy === 'clear'" @click="confirmClear = true">Clear demo data</UiButton>
    </section>
    <UiDialog :open="confirmClear" title="Clear all demo activity?" description="This permanently removes every shift, report, handover, ticket and notification in this local demo." @close="confirmClear = false">
      <p class="text-[13.5px] text-ink-2">Accounts, departments, shift patterns, source records and the audit log are kept.</p>
      <template #footer>
        <UiButton variant="ghost" @click="confirmClear = false">Cancel</UiButton>
        <UiButton variant="danger" :loading="busy === 'clear'" @click="clearDemo">Clear everything</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
