<script setup lang="ts">
import { computed, ref } from 'vue';
import type { IssueStatus, ReportStatus } from '@sh/shared';
import MarkDoneDialog from '@/components/MarkDoneDialog.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SeverityTag from '@/components/ui/SeverityTag.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, day, shiftRange, time } from '@/lib/format';
import type { Decision } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useNotifications } from '@/stores/notifications';
import { useToast } from '@/stores/toast';

/**
 * Crew takeover. Several workers hand over at the end of a shift and several take over:
 * everyone on the incoming shift sees every approved handover, one combined checklist where
 * each item appears once, who has taken what, and whose handovers are still on the way.
 */
interface Item {
  id: string;
  code: string;
  kind: 'problem' | 'task';
  title: string;
  status: IssueStatus;
  severity: 'low' | 'medium' | 'high' | 'critical';
  is_safety: boolean;
  photo_count: number;
  owner_id: string | null;
  owner_name: string | null;
  from?: string[];
}
interface Handover {
  delivery_id: string;
  delivered_at: string;
  report_reference: string;
  approved_content: NonNullable<Decision['approved_content']>;
  outgoing_label: string;
  outgoing_date: string;
  outgoing_ended_at: string;
  outgoing_employee: string;
  reviewer_name: string;
  acknowledged_at: string | null;
  acknowledgment_note: string | null;
}
interface Outgoing {
  employee_name: string;
  outgoing_shift_id: string;
  outgoing_label: string;
  outgoing_ends_at: string;
  report_status: ReportStatus | 'not_started';
}
interface BoardShift {
  id: string;
  label: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  is_now: boolean;
  outgoing: Outgoing[];
  handovers: Handover[];
  checklist: Item[];
}
interface Board {
  shifts: BoardShift[];
  carried_over: Item[];
  earlier: Handover[];
}

const auth = useAuth();
const toast = useToast();
const notes = useNotifications();
// Handovers and who took what change during the shift; keep the board current.
const { data, loading, error, reload } = useAsync(() => api.get<Board>('/handovers/board'), [], { refreshMs: 30_000 });
const ackNote = ref<Record<string, string>>({});
const busy = ref<string | null>(null);
const marking = ref<Item | null>(null);
const filter = ref<'all' | 'mine' | 'free'>('all');
const opened = ref<Record<string, boolean>>({});
const showEarlier = ref(false);

const isEmpty = computed(() => !!data.value && !data.value.shifts.length && !data.value.carried_over.length && !data.value.earlier.length);
const isDone = (s: IssueStatus) => s === 'resolved' || s === 'closed';
const canWork = (i: Item) => i.status === 'open' || i.status === 'in_progress';
const mine = (i: Item) => i.owner_id === auth.profile?.id;
const progress = (s: BoardShift) => ({ done: s.checklist.filter((i) => isDone(i.status)).length, total: s.checklist.length });
const waitingCount = (s: BoardShift) => s.handovers.filter((h) => !h.acknowledged_at).length;
const visible = (s: BoardShift) =>
  s.checklist.filter((i) => (filter.value === 'mine' ? mine(i) : filter.value === 'free' ? !i.owner_id && canWork(i) : true));
const isOpen = (h: Handover) => opened.value[h.delivery_id] ?? !h.acknowledged_at;

/** Where each outgoing worker's handover is, in words the incoming crew understands. */
function stage(o: Outgoing): { text: string; tone: string } {
  switch (o.report_status) {
    case 'delivered':
    case 'approved':
      return { text: 'Handover ready', tone: 'text-ok' };
    case 'not_started':
    case 'draft':
      return { text: 'Still writing', tone: 'text-ink-3' };
    case 'revision_requested':
      return { text: 'Fixing it for the supervisor', tone: 'text-warn' };
    case 'rejected':
      return { text: 'Not approved — ask the supervisor', tone: 'text-bad' };
    default:
      return { text: 'Supervisor is checking', tone: 'text-info' };
  }
}
const pendingOutgoing = (s: BoardShift) => s.outgoing.filter((o) => o.report_status !== 'delivered' && o.report_status !== 'approved').length;

async function run(key: string, fn: () => Promise<unknown>, ok: string) {
  busy.value = key;
  try {
    await fn();
    toast.ok(ok);
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
    await reload(true);
  } finally {
    busy.value = null;
  }
}
const take = (i: Item) => run(`take:${i.id}`, () => api.post(`/issues/${i.id}/claim`, { take: true }), `You took ${i.code}`);
const letGo = (i: Item) => run(`take:${i.id}`, () => api.post(`/issues/${i.id}/claim`, { take: false }), `${i.code} is free for anyone again`);

async function acknowledge(h: Handover) {
  await run(h.delivery_id, () => api.post(`/handovers/${h.delivery_id}/acknowledge`, { note: ackNote.value[h.delivery_id] ?? '' }), 'Handover acknowledged');
  void notes.refresh();
}
async function acknowledgeAll(s: BoardShift) {
  await run(
    `all:${s.id}`,
    async () => {
      for (const h of s.handovers.filter((x) => !x.acknowledged_at)) await api.post(`/handovers/${h.delivery_id}/acknowledge`, { note: '' });
    },
    'All handovers acknowledged',
  );
  void notes.refresh();
}
async function afterDone() {
  marking.value = null;
  await reload(true);
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <PageHeader title="Shift takeover" description="Everything the previous shift left for your crew, in one list. Take an item so nobody doubles up." />
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="isEmpty"
      empty-title="Nothing to take over yet"
      empty-text="When you have a shift coming up, the previous crew’s approved handovers appear here."
      @retry="reload()"
    >
      <div v-if="data" class="space-y-6">
        <section v-for="s in data.shifts" :key="s.id" class="space-y-4">
          <header class="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p class="eyebrow">Your shift · {{ s.is_now ? 'on now' : new Date(s.starts_at) > new Date() ? 'coming up' : 'earlier today' }}</p>
              <h2 class="text-[17px] font-semibold">{{ s.label }}</h2>
              <p class="text-[13px] text-ink-3">{{ day(s.starts_at, s.timezone) }} · {{ shiftRange(s) }}</p>
            </div>
            <p v-if="progress(s).total" class="text-[13px] text-ink-3 tnum">{{ progress(s).done }} of {{ progress(s).total }} done</p>
          </header>

          <!-- Who is handing over to this crew -->
          <div v-if="s.outgoing.length" class="card px-4 py-3">
            <p class="text-[13px] font-medium text-ink-2">
              Handing over to you: {{ s.outgoing.length }} {{ s.outgoing.length === 1 ? 'worker' : 'workers' }}
              <span v-if="pendingOutgoing(s)" class="font-normal text-ink-3">· {{ pendingOutgoing(s) }} still on the way</span>
            </p>
            <ul class="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
              <li v-for="o in s.outgoing" :key="o.outgoing_shift_id + o.employee_name" class="flex items-center gap-1.5">
                <span class="font-medium">{{ o.employee_name }}</span>
                <span :class="stage(o).tone">· {{ stage(o).text }}</span>
              </li>
            </ul>
          </div>

          <!-- One checklist for the whole crew -->
          <div v-if="s.checklist.length" class="card">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h3 class="text-[15px] font-semibold">Crew checklist</h3>
              <div class="flex rounded-md border border-line p-0.5 text-[12.5px]" role="tablist" aria-label="Filter checklist">
                <button
                  v-for="f in [{ k: 'all', l: 'All' }, { k: 'free', l: 'Not taken' }, { k: 'mine', l: 'Mine' }] as const"
                  :key="f.k"
                  type="button"
                  role="tab"
                  :aria-selected="filter === f.k"
                  class="rounded px-2.5 py-1"
                  :class="filter === f.k ? 'bg-sunken font-medium text-ink' : 'text-ink-3 hover:text-ink'"
                  @click="filter = f.k"
                >
                  {{ f.l }}
                </button>
              </div>
            </div>
            <div class="h-1 bg-sunken" aria-hidden="true">
              <div class="grow-x h-full bg-ok transition-all" :style="{ width: `${(progress(s).done / progress(s).total) * 100}%` }" />
            </div>
            <ul class="stagger divide-y divide-line">
              <li v-for="i in visible(s)" :key="i.id" class="flex flex-wrap items-start gap-3 px-5 py-3.5 sm:flex-nowrap">
                <span
                  class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px]"
                  :class="isDone(i.status) ? 'pop border-ok bg-ok text-white' : i.status === 'resolution_submitted' ? 'border-violet bg-violet-soft text-violet' : 'border-line-strong'"
                  aria-hidden="true"
                  >{{ isDone(i.status) ? '✓' : i.status === 'resolution_submitted' ? '…' : '' }}</span
                >
                <div class="min-w-0 flex-1">
                  <RouterLink :to="`/tasks/${i.id}`" class="text-[14px] hover:underline" :class="{ 'text-ink-3 line-through': isDone(i.status) }">{{ i.title }}</RouterLink>
                  <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ink-3">
                    <span>{{ i.kind === 'task' ? 'Task' : 'Problem' }} · <span class="tnum">{{ i.code }}</span></span>
                    <SeverityTag v-if="i.kind === 'problem'" :severity="i.severity" :safety="i.is_safety" />
                    <span v-if="i.from?.length">· from {{ i.from.join(', ') }}</span>
                    <span v-if="i.photo_count">· {{ i.photo_count }} photo{{ i.photo_count > 1 ? 's' : '' }}</span>
                  </p>
                  <p class="mt-0.5 text-[12.5px]">
                    <span v-if="i.status === 'resolution_submitted'" class="text-violet">Waiting for supervisor to confirm</span>
                    <span v-else-if="isDone(i.status)" class="text-ok">Confirmed done</span>
                    <span v-else-if="i.status === 'pending_verification' || i.status === 'reported'" class="text-ink-3">Supervisor is checking this problem</span>
                    <span v-else-if="mine(i)" class="font-medium text-accent-ink">You took this</span>
                    <span v-else-if="i.owner_name" class="text-ink-2">{{ i.owner_name }} is on it</span>
                    <span v-else class="text-warn">Nobody has taken this yet</span>
                  </p>
                </div>
                <div v-if="canWork(i)" class="flex shrink-0 items-center gap-2">
                  <UiButton v-if="!i.owner_id" size="sm" :loading="busy === `take:${i.id}`" @click="take(i)">I’ll take it</UiButton>
                  <button v-else-if="mine(i)" type="button" class="text-[12.5px] text-ink-3 hover:text-ink" :disabled="busy === `take:${i.id}`" @click="letGo(i)">Let go</button>
                  <UiButton v-if="!i.owner_id || mine(i)" size="sm" variant="primary" @click="marking = i">Mark done</UiButton>
                </div>
              </li>
              <li v-if="!visible(s).length" class="px-5 py-4 text-[13.5px] text-ink-3">
                {{ filter === 'mine' ? 'You haven’t taken anything yet.' : 'Everything on this list has been taken.' }}
              </li>
            </ul>
          </div>

          <!-- The handovers themselves -->
          <div v-if="s.handovers.length" class="stagger space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-[15px] font-semibold">
                Handovers to read
                <span v-if="waitingCount(s)" class="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-medium text-accent-ink tnum">{{ waitingCount(s) }} new</span>
              </h3>
              <UiButton v-if="waitingCount(s) > 1" size="sm" :loading="busy === `all:${s.id}`" @click="acknowledgeAll(s)">I’ve read them all</UiButton>
            </div>
            <article v-for="h in s.handovers" :key="h.delivery_id" class="card" :class="{ 'ring-1 ring-accent/30': !h.acknowledged_at }">
              <button type="button" class="flex w-full flex-wrap items-start justify-between gap-3 px-5 py-3.5 text-left" :aria-expanded="isOpen(h)" @click="opened[h.delivery_id] = !isOpen(h)">
                <div>
                  <p class="text-[15px] font-semibold">From {{ h.outgoing_employee }} <span class="font-normal text-ink-3">· {{ h.outgoing_label }}</span></p>
                  <p class="text-[12.5px] text-ink-3"><span class="tnum">{{ h.report_reference }}</span> · ended {{ time(h.outgoing_ended_at, s.timezone) }} · checked by {{ h.reviewer_name }}</p>
                </div>
                <span v-if="h.acknowledged_at" class="text-[12.5px] text-ok tnum">Read {{ dateTime(h.acknowledged_at) }}</span>
                <span v-else class="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-ink">New</span>
              </button>
              <!-- Slides open and closed; while closed it is inert so its fields can't be tabbed into. -->
              <div class="expand" :class="{ open: isOpen(h) }">
              <div :inert="!isOpen(h)">
                <div class="space-y-3 border-t border-line px-5 py-4">
                  <p class="text-[14.5px] leading-relaxed whitespace-pre-wrap">{{ h.approved_content.summary }}</p>
                  <p v-if="h.approved_content.notes_for_incoming" class="rounded-md bg-sunken px-3.5 py-2.5 text-[14px]">{{ h.approved_content.notes_for_incoming }}</p>
                  <details v-if="h.approved_content.completed_tasks.length" class="text-[14px]">
                    <summary class="cursor-pointer text-ink-2">What {{ h.outgoing_employee.split(' ')[0] }} finished ({{ h.approved_content.completed_tasks.length }})</summary>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-ink-2">
                      <li v-for="(t, n) in h.approved_content.completed_tasks" :key="n">{{ t.description }}</li>
                    </ul>
                  </details>
                </div>
                <footer v-if="!h.acknowledged_at" class="flex flex-col gap-3 border-t border-line bg-canvas/60 px-5 py-3.5 sm:flex-row sm:items-end">
                  <label class="flex-1 text-[13px] text-ink-2">
                    Note (optional)
                    <input v-model="ackNote[h.delivery_id]" class="field-input mt-1" maxlength="500" placeholder="e.g. Read at turnover with the team" />
                  </label>
                  <UiButton variant="primary" :loading="busy === h.delivery_id" @click="acknowledge(h)">I’ve read this</UiButton>
                </footer>
                <p v-else-if="h.acknowledgment_note" class="border-t border-line px-5 py-3 text-[13px] text-ink-2">Your note: {{ h.acknowledgment_note }}</p>
              </div>
              </div>
            </article>
          </div>
          <p v-else-if="s.outgoing.length" class="text-[13.5px] text-ink-3">No handover has been approved for your shift yet. They appear here as soon as the supervisor checks them.</p>
        </section>

        <!-- Unfinished work from before -->
        <section v-if="data.carried_over.length" class="card">
          <div class="flex items-baseline justify-between border-b border-line px-5 py-3.5">
            <h3 class="text-[15px] font-semibold">Still open from earlier shifts</h3>
            <RouterLink to="/tasks" class="text-[13px] link">All open items</RouterLink>
          </div>
          <ul class="stagger divide-y divide-line">
            <li v-for="i in data.carried_over" :key="i.id" class="flex flex-wrap items-center gap-3 px-5 py-3 sm:flex-nowrap">
              <div class="min-w-0 flex-1">
                <RouterLink :to="`/tasks/${i.id}`" class="text-[14px] hover:underline">{{ i.title }}</RouterLink>
                <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
                  <span>{{ i.kind === 'task' ? 'Task' : 'Problem' }} · <span class="tnum">{{ i.code }}</span></span>
                  <SeverityTag v-if="i.kind === 'problem'" :severity="i.severity" :safety="i.is_safety" />
                  <span v-if="i.status === 'resolution_submitted'" class="text-violet">· Waiting for supervisor</span>
                  <span v-else-if="mine(i)" class="text-accent-ink">· You took this</span>
                  <span v-else-if="i.owner_name">· {{ i.owner_name }} is on it</span>
                  <span v-else class="text-warn">· Nobody has taken this</span>
                </p>
              </div>
              <UiButton v-if="canWork(i) && !i.owner_id" size="sm" :loading="busy === `take:${i.id}`" @click="take(i)">I’ll take it</UiButton>
              <UiButton v-else-if="canWork(i) && mine(i)" size="sm" variant="primary" @click="marking = i">Mark done</UiButton>
            </li>
          </ul>
        </section>

        <div v-if="data.earlier.length">
          <button
            type="button"
            class="w-full rounded-lg border border-line bg-surface px-4 py-3 text-[13.5px] font-medium text-ink-2 hover:bg-sunken"
            @click="showEarlier = !showEarlier"
          >
            {{ showEarlier ? 'Hide earlier handovers' : `Show ${data.earlier.length} earlier handover${data.earlier.length === 1 ? '' : 's'}` }}
          </button>
          <ul v-if="showEarlier" class="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            <li v-for="h in data.earlier" :key="h.delivery_id" class="px-4 py-3 text-[13.5px]">
              <p class="font-medium">From {{ h.outgoing_employee }} · {{ h.outgoing_label }}, {{ day(h.outgoing_date) }}</p>
              <p class="mt-0.5 text-ink-2">{{ h.approved_content.summary }}</p>
            </li>
          </ul>
        </div>

        <p class="text-[13px] text-ink-3">
          Anything your crew doesn’t finish stays open for the next shift. New problems you find go in your own end-of-shift report.
        </p>
      </div>
    </StateBlock>

    <MarkDoneDialog :issue="marking" @close="marking = null" @done="afterDone" />
  </div>
</template>
