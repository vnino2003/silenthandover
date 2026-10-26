<script setup lang="ts">
import { ref } from 'vue';
import ApprovedHandoverView from '@/components/ApprovedHandoverView.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, day, time } from '@/lib/format';
import type { Decision } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useNotifications } from '@/stores/notifications';
import { useToast } from '@/stores/toast';

interface Incoming {
  delivery_id: string;
  delivered_at: string;
  report_reference: string;
  approved_content: NonNullable<Decision['approved_content']>;
  decided_at: string;
  outgoing_label: string;
  outgoing_date: string;
  outgoing_ended_at: string;
  incoming_label: string;
  incoming_starts_at: string;
  outgoing_employee: string;
  reviewer_name: string;
  acknowledged_at: string | null;
  acknowledgment_note: string | null;
}

const toast = useToast();
const notes = useNotifications();
const { data, loading, error, reload } = useAsync(() => api.get<Incoming[]>('/handovers/incoming'));
const ackNote = ref<Record<string, string>>({});
const busy = ref<string | null>(null);

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
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <PageHeader
      title="Incoming handover"
      description="Approved handovers from the previous shift. Only reports verified by a supervisor appear here."
    />
    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!data?.length"
      empty-title="No handovers for you yet"
      empty-text="When the previous shift’s report is verified, it is delivered here before your shift starts."
      @retry="reload()"
    >
      <div class="space-y-5">
        <article v-for="h in data" :key="h.delivery_id" class="card" :class="{ 'ring-1 ring-accent/30': !h.acknowledged_at }">
          <header class="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <p class="eyebrow tnum">{{ h.report_reference }}</p>
              <h2 class="mt-0.5 text-[16px] font-semibold">{{ h.outgoing_label }} → {{ h.incoming_label }}</h2>
              <p class="text-[13px] text-ink-3">
                From {{ h.outgoing_employee }} · {{ day(h.outgoing_date) }}, ended {{ time(h.outgoing_ended_at) }} · verified by {{ h.reviewer_name }}
              </p>
            </div>
            <span v-if="h.acknowledged_at" class="text-[13px] text-ok tnum">Acknowledged {{ dateTime(h.acknowledged_at) }}</span>
            <span v-else class="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-ink">Awaiting your acknowledgment</span>
          </header>
          <div class="px-5 py-4">
            <ApprovedHandoverView :content="h.approved_content" />
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
        <p class="text-[13px] text-ink-3">Acknowledging confirms you read the handover. It does not close or resolve any issue — update issues from the Open issues page.</p>
      </div>
    </StateBlock>
  </div>
</template>
