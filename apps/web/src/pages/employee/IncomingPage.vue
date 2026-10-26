<script setup lang="ts">
import { ref } from 'vue';
import type { IssueStatus } from '@sh/shared';
import MarkDoneDialog from '@/components/MarkDoneDialog.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SeverityTag from '@/components/ui/SeverityTag.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, day, time } from '@/lib/format';
import type { Decision } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useNotifications } from '@/stores/notifications';
import { useToast } from '@/stores/toast';

interface ChecklistEntry {
  id: string;
  code: string;
  kind: 'problem' | 'task';
  title: string;
  status: IssueStatus;
  severity: 'low' | 'medium' | 'high' | 'critical';
  is_safety: boolean;
  photo_count: number;
}
interface Incoming {
  delivery_id: string;
  delivered_at: string;
  report_reference: string;
  approved_content: NonNullable<Decision['approved_content']>;
  outgoing_label: string;
  outgoing_date: string;
  outgoing_ended_at: string;
  incoming_label: string;
  outgoing_employee: string;
  reviewer_name: string;
  acknowledged_at: string | null;
  acknowledgment_note: string | null;
  checklist: Record<string, ChecklistEntry>;
}

const toast = useToast();
const notes = useNotifications();
const { data, loading, error, reload } = useAsync(() => api.get<Incoming[]>('/handovers/incoming'));
const ackNote = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
const marking = ref<ChecklistEntry | null>(null);

/** Problems first, then tasks, each with its live status. Items from older handovers without an id stay as plain text. */
function items(h: Incoming) {
  const c = h.approved_content;
  return [
    ...c.unresolved_issues.map((i) => ({ text: i.title, entry: i.issue_id ? h.checklist[i.issue_id] : undefined, kind: 'problem' as const })),
    ...c.pending_actions.map((a) => ({ text: a.description, entry: a.issue_id ? h.checklist[a.issue_id] : undefined, kind: 'task' as const })),
  ];
}
const isDone = (s?: IssueStatus) => s === 'resolved' || s === 'closed';
const progress = (h: Incoming) => {
  const tracked = items(h).filter((i) => i.entry);
  return { done: tracked.filter((i) => isDone(i.entry!.status)).length, total: tracked.length };
};

async function acknowledge(item: Incoming) {
  busy.value = item.delivery_id;
  try {
    await api.post(`/handovers/${item.delivery_id}/acknowledge`, { note: ackNote.value[item.delivery_id] ?? '' });
    toast.ok('Handover acknowledged');
    await reload(true);
    void notes.refresh();
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
async function afterDone() {
  marking.value = null;
  await reload(true);
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <PageHeader title="Incoming handover" description="What the previous shift left for you, checked by your supervisor. Tick items off as you finish them." />
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!data?.length"
      empty-title="No handovers for you yet"
      empty-text="When the previous shift’s report is approved, it appears here before your shift starts."
      @retry="reload()"
    >
      <div class="space-y-5">
        <article v-for="h in data" :key="h.delivery_id" class="card" :class="{ 'ring-1 ring-accent/30': !h.acknowledged_at }">
          <header class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <p class="eyebrow tnum">{{ h.report_reference }}</p>
              <h2 class="mt-0.5 text-[16px] font-semibold">From {{ h.outgoing_employee }} · {{ h.outgoing_label }}</h2>
              <p class="text-[13px] text-ink-3">{{ day(h.outgoing_date) }}, ended {{ time(h.outgoing_ended_at) }} · checked by {{ h.reviewer_name }}</p>
            </div>
            <span v-if="h.acknowledged_at" class="text-[13px] text-ok tnum">Read {{ dateTime(h.acknowledged_at) }}</span>
            <span v-else class="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-ink">New</span>
          </header>

          <div class="space-y-4 px-5 py-4">
            <p class="text-[15px] leading-relaxed whitespace-pre-wrap">{{ h.approved_content.summary }}</p>
            <p v-if="h.approved_content.notes_for_incoming" class="rounded-md bg-sunken px-3.5 py-2.5 text-[14px]">{{ h.approved_content.notes_for_incoming }}</p>

            <section v-if="items(h).length">
              <div class="flex items-baseline justify-between">
                <h3 class="text-[15px] font-semibold">Your checklist</h3>
                <p v-if="progress(h).total" class="text-[13px] text-ink-3 tnum">{{ progress(h).done }} of {{ progress(h).total }} done</p>
              </div>
              <div v-if="progress(h).total" class="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                <div class="h-full rounded-full bg-ok transition-all" :style="{ width: `${(progress(h).done / progress(h).total) * 100}%` }" />
              </div>
              <ul class="mt-3 divide-y divide-line rounded-md border border-line">
                <li v-for="(item, n) in items(h)" :key="n" class="flex items-start gap-3 px-3.5 py-3">
                  <span
                    class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px]"
                    :class="isDone(item.entry?.status) ? 'border-ok bg-ok text-white' : item.entry?.status === 'resolution_submitted' ? 'border-violet bg-violet-soft text-violet' : 'border-line-strong'"
                    aria-hidden="true"
                  >{{ isDone(item.entry?.status) ? '✓' : item.entry?.status === 'resolution_submitted' ? '…' : '' }}</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-[14px]" :class="{ 'text-ink-3 line-through': isDone(item.entry?.status) }">{{ item.text }}</p>
                    <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
                      <span>{{ item.kind === 'task' ? 'Task' : 'Problem' }}</span>
                      <template v-if="item.entry">
                        <span class="tnum">· {{ item.entry.code }}</span>
                        <SeverityTag v-if="item.kind === 'problem'" :severity="item.entry.severity" :safety="item.entry.is_safety" />
                        <span v-if="item.entry.status === 'resolution_submitted'" class="text-violet">Waiting for supervisor to confirm</span>
                        <span v-else-if="isDone(item.entry.status)" class="text-ok">Confirmed done</span>
                        <span v-else-if="item.entry.status === 'pending_verification' || item.entry.status === 'reported'">Supervisor is checking this problem</span>
                        <span v-if="item.entry.photo_count">· {{ item.entry.photo_count }} photo{{ item.entry.photo_count > 1 ? 's' : '' }}</span>
                      </template>
                    </p>
                  </div>
                  <UiButton
                    v-if="item.entry && (item.entry.status === 'open' || item.entry.status === 'in_progress')"
                    size="sm"
                    @click="marking = item.entry"
                  >
                    Mark done
                  </UiButton>
                  <RouterLink v-else-if="item.entry" :to="`/tasks/${item.entry.id}`" class="shrink-0 text-[13px] link">View</RouterLink>
                </li>
              </ul>
            </section>

            <details v-if="h.approved_content.completed_tasks.length" class="text-[14px]">
              <summary class="cursor-pointer text-ink-2">What the previous shift finished ({{ h.approved_content.completed_tasks.length }})</summary>
              <ul class="mt-2 list-disc space-y-1 pl-5 text-ink-2">
                <li v-for="(t, n) in h.approved_content.completed_tasks" :key="n">{{ t.description }}</li>
              </ul>
            </details>
          </div>

          <footer v-if="!h.acknowledged_at" class="flex flex-col gap-3 border-t border-line bg-canvas/60 px-5 py-4 sm:flex-row sm:items-end">
            <label class="flex-1 text-[13px] text-ink-2">
              Note (optional)
              <input v-model="ackNote[h.delivery_id]" class="field-input mt-1" maxlength="500" placeholder="e.g. Read at turnover with the team" />
            </label>
            <UiButton variant="primary" :loading="busy === h.delivery_id" @click="acknowledge(h)">I’ve read this handover</UiButton>
          </footer>
          <p v-else-if="h.acknowledgment_note" class="border-t border-line px-5 py-3 text-[13px] text-ink-2">Your note: {{ h.acknowledgment_note }}</p>
        </article>
        <p class="text-[13px] text-ink-3">
          Anything you don’t finish stays on the list for the next shift. New problems you find go in your own end-of-shift report.
        </p>
      </div>
    </StateBlock>

    <MarkDoneDialog :issue="marking" @close="marking = null" @done="afterDone" />
  </div>
</template>
