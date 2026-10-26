<script setup lang="ts">
import { computed } from 'vue';
import { classifyWindow, type ReportStatus } from '@sh/shared';
import DutyRing from '@/components/DutyRing.vue';
import ReportingWindow from '@/components/ReportingWindow.vue';
import SeverityTag from '@/components/ui/SeverityTag.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api } from '@/lib/api';
import { dateTime, day, longDate, relative, shiftRange } from '@/lib/format';
import type { IssueRow, ShiftView } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useNow } from '@/lib/useNow';
import { useAuth } from '@/stores/auth';

interface Dashboard {
  server_now: string;
  current_shift: ShiftView | null;
  upcoming: ShiftView[];
  missed: ShiftView[];
  needs_revision: { id: string; reference_code: string; label: string; shift_date: string }[];
  incoming: {
    delivery_id: string;
    delivered_at: string;
    report_reference: string;
    outgoing_label: string;
    outgoing_employee: string;
    incoming_label: string;
    incoming_starts_at: string;
    acknowledged_at: string | null;
  }[];
  tasks: IssueRow[];
  recent_reports: { id: string; reference_code: string; status: ReportStatus; last_submitted_at: string | null; label: string; shift_date: string }[];
}

const auth = useAuth();
const now = useNow();
const { data, loading, error, reload } = useAsync(() => api.get<Dashboard>('/employee/dashboard'), [], { refreshMs: 60_000 });

const tz = computed(() => auth.profile?.department_timezone ?? undefined);
const greeting = computed(() => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz.value }).format(now.value));
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${auth.profile?.full_name.split(' ')[0] ?? ''}`;
});

const current = computed(() => data.value?.current_shift ?? null);
const liveState = computed(() => {
  const s = current.value;
  if (!s) return null;
  if (s.window_state && !['early_draft', 'open', 'override', 'closed', 'not_started'].includes(s.window_state)) return s.window_state;
  return classifyWindow(s, now.value);
});

const action = computed(() => {
  const s = current.value;
  if (!s) return null;
  const status = s.report_status;
  if (status && !['draft', 'revision_requested'].includes(status)) return { label: 'View submitted report', to: `/reports/${s.report_id}`, enabled: true, primary: false };
  const state = liveState.value;
  const canWrite = state === 'open' || state === 'override' || state === 'early_draft';
  const label = status === 'draft' ? (state === 'early_draft' ? 'Continue draft' : 'Continue report') : state === 'early_draft' ? 'Start a draft' : 'Submit shift report';
  return { label, to: `/shifts/${s.id}/report`, enabled: canWrite, primary: state !== 'early_draft' };
});

const pendingAcks = computed(() => data.value?.incoming.filter((i) => !i.acknowledged_at) ?? []);
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <header class="mb-6">
      <p class="eyebrow">{{ longDate(now, tz) }}</p>
      <h1 class="mt-1 text-[24px] font-semibold tracking-[-0.015em]">{{ greeting }}</h1>
    </header>

    <StateBlock :loading="loading" :error="error" :lines="5" @retry="reload()">
      <template v-if="data">
        <div v-if="data.needs_revision.length" class="mb-5 rounded-lg border border-violet/25 bg-violet-soft px-4 py-3">
          <p class="text-[14px] font-medium text-violet">Your supervisor asked for a revision</p>
          <ul class="mt-1 space-y-0.5 text-[14px]">
            <li v-for="r in data.needs_revision" :key="r.id">
              <RouterLink :to="`/reports/${r.id}`" class="link">{{ r.reference_code }} · {{ r.label }}, {{ day(r.shift_date) }}</RouterLink>
            </li>
          </ul>
        </div>

        <div class="grid gap-5 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
          <!-- Current shift and the primary action -->
          <section class="card p-5 sm:p-6" aria-labelledby="shift-h">
            <template v-if="current">
              <p class="eyebrow">Current shift</p>
              <h2 id="shift-h" class="mt-1 text-[20px] font-semibold tracking-[-0.01em]">{{ current.label }}</h2>
              <p class="mt-0.5 text-[14px] text-ink-2 tnum">
                {{ day(current.starts_at, current.timezone) }} · {{ shiftRange(current) }}
              </p>
              <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
                <div><dt class="text-ink-3">Department</dt><dd>{{ current.department_name }}</dd></div>
                <div v-if="current.supervisor_name"><dt class="text-ink-3">Supervisor</dt><dd>{{ current.supervisor_name }}</dd></div>
              </dl>
              <div class="mt-5 rounded-lg border border-line bg-canvas/60 p-4">
                <DutyRing :shift="current" :now="now" />
              </div>
              <div class="mt-5 border-t border-line pt-5">
                <ReportingWindow :shift="current" :now="now" />
                <div class="mt-5 flex flex-wrap items-center gap-3">
                  <UiButton v-if="action" :variant="action.primary ? 'primary' : 'secondary'" size="lg" :to="action.to" :disabled="!action.enabled">
                    {{ action.label }}
                  </UiButton>
                  <StatusBadge v-if="current.report_status" :report="current.report_status" />
                </div>
              </div>
            </template>
            <template v-else>
              <p class="eyebrow">Current shift</p>
              <h2 id="shift-h" class="mt-1 text-[18px] font-semibold">You’re not on shift right now</h2>
              <p v-if="data.upcoming[0]" class="mt-1 text-[14px] text-ink-2">
                Next: {{ data.upcoming[0].label }}, {{ day(data.upcoming[0].starts_at, data.upcoming[0].timezone) }} · {{ shiftRange(data.upcoming[0]) }}
              </p>
              <p v-else class="mt-1 text-[14px] text-ink-2">No upcoming shifts are scheduled for you this week.</p>
            </template>
          </section>

          <!-- Incoming handover -->
          <section class="card p-5" aria-labelledby="incoming-h">
            <div class="flex items-baseline justify-between">
              <h2 id="incoming-h" class="text-[15px] font-semibold">Incoming handover</h2>
              <RouterLink to="/handover" class="text-[13px] link">Open</RouterLink>
            </div>
            <div v-if="pendingAcks.length" class="mt-3 rounded-md bg-accent-soft px-3.5 py-3">
              <p class="text-[14px] font-medium text-accent-ink">{{ pendingAcks.length }} handover{{ pendingAcks.length > 1 ? 's' : '' }} waiting for you</p>
              <p class="mt-0.5 text-[13px] text-ink-2">From {{ pendingAcks[0]!.outgoing_employee }} · {{ pendingAcks[0]!.outgoing_label }}</p>
              <p class="mt-1 text-[12.5px] text-ink-3 tnum">For your {{ pendingAcks[0]!.incoming_label }} shift · starts {{ dateTime(pendingAcks[0]!.incoming_starts_at, tz) }}</p>
              <UiButton class="mt-3" size="sm" variant="primary" to="/handover">Read and acknowledge</UiButton>
            </div>
            <p v-else-if="data.incoming.length" class="mt-3 text-[14px] text-ink-2">All handovers acknowledged.</p>
            <p v-else class="mt-3 text-[14px] text-ink-3">Approved handovers for your shifts appear here.</p>
          </section>
        </div>

        <div v-if="data.missed.length" class="mt-5 rounded-lg border border-line bg-surface px-4 py-3 text-[14px]">
          <p class="font-medium">Reports not submitted</p>
          <p class="text-ink-2">
            <template v-for="(m, i) in data.missed" :key="m.id">{{ i ? ', ' : '' }}{{ m.label }} ({{ day(m.starts_at, m.timezone) }})</template>
            — the window has closed. Contact your supervisor if you still need to report.
          </p>
        </div>

        <div class="mt-5 grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <section class="card" aria-labelledby="tasks-h">
            <div class="flex items-baseline justify-between px-5 pt-4">
              <h2 id="tasks-h" class="text-[15px] font-semibold">Open issues in your department</h2>
              <RouterLink to="/tasks" class="text-[13px] link">All</RouterLink>
            </div>
            <ul v-if="data.tasks.length" class="mt-2 divide-y divide-line">
              <li v-for="t in data.tasks" :key="t.id">
                <RouterLink :to="`/tasks/${t.id}`" class="flex items-start justify-between gap-3 px-5 py-3 hover:bg-canvas">
                  <span class="min-w-0">
                    <span class="block truncate text-[14px] font-medium">{{ t.title }}</span>
                    <span class="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-3">
                      <span class="tnum">{{ t.code }}</span><SeverityTag :severity="t.severity" :safety="t.is_safety" />
                      <span v-if="t.assigned_to_me" class="font-medium text-accent">Assigned to you</span>
                    </span>
                  </span>
                  <StatusBadge :issue="t.status" />
                </RouterLink>
              </li>
            </ul>
            <p v-else class="px-5 pt-2 pb-5 text-[14px] text-ink-3">No open issues.</p>
          </section>

          <section class="card" aria-labelledby="recent-h">
            <div class="flex items-baseline justify-between px-5 pt-4">
              <h2 id="recent-h" class="text-[15px] font-semibold">Your recent reports</h2>
              <RouterLink to="/reports" class="text-[13px] link">All</RouterLink>
            </div>
            <ul v-if="data.recent_reports.length" class="mt-2 divide-y divide-line">
              <li v-for="r in data.recent_reports" :key="r.id">
                <RouterLink :to="`/reports/${r.id}`" class="flex items-center justify-between gap-3 px-5 py-3 hover:bg-canvas">
                  <span class="min-w-0">
                    <span class="block text-[14px] font-medium tnum">{{ r.reference_code }}</span>
                    <span class="block text-[12.5px] text-ink-3">{{ r.label }} · {{ day(r.shift_date) }}<template v-if="r.last_submitted_at"> · submitted {{ relative(r.last_submitted_at, now) }}</template></span>
                  </span>
                  <StatusBadge :report="r.status" />
                </RouterLink>
              </li>
            </ul>
            <p v-else class="px-5 pt-2 pb-5 text-[14px] text-ink-3">You haven’t written a report yet.</p>
            <div v-if="data.upcoming.length" class="border-t border-line px-5 py-3">
              <p class="eyebrow">Upcoming shifts</p>
              <ul class="mt-1.5 space-y-1 text-[14px] text-ink-2 tnum">
                <li v-for="u in data.upcoming" :key="u.id">{{ day(u.starts_at, u.timezone) }} — {{ u.label }}, {{ shiftRange(u) }}</li>
              </ul>
            </div>
          </section>
        </div>
      </template>
    </StateBlock>
  </div>
</template>
