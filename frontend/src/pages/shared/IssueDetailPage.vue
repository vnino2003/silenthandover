<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { allowedIssueTransitions, ISSUE_STATUS_LABELS, type IssueStatus } from '@sh/shared';
import IssuePhoto from '@/components/IssuePhoto.vue';
import MarkDoneDialog from '@/components/MarkDoneDialog.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SeverityTag from '@/components/ui/SeverityTag.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { IssueRow } from '@/lib/types';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Detail {
  issue: IssueRow & { description: string; created_by_name: string | null; resolved_by_name: string | null; resolved_at: string | null; created_at: string };
  updates: { id: string; kind: string; from_status: IssueStatus | null; to_status: IssueStatus | null; note: string; created_at: string; author_name: string | null; author_role: string | null }[];
  photos: { id: string; update_id: string | null; created_at: string; uploaded_by_name: string | null }[];
}

const route = useRoute();
const auth = useAuth();
const toast = useToast();
const id = computed(() => String(route.params.id));
const isManager = computed(() => auth.role === 'manager');
const base = computed(() => (isManager.value ? '/manager/issues' : '/tasks'));
const { data, loading, error, reload } = useAsync(() => api.get<Detail>(`/issues/${id.value}`), [id]);
const staff = useAsync(() => (isManager.value ? api.get<{ id: string; full_name: string; role: string }[]>('/department/staff') : Promise.resolve([])));

const ACTION_LABEL: Partial<Record<IssueStatus, string>> = {
  in_progress: 'I’m working on it',
  resolution_submitted: 'Mark as done',
  resolved: 'Confirm done',
  closed: 'Close',
  open: 'Open',
  pending_verification: 'Needs verification',
};
const NOTE_REQUIRED: IssueStatus[] = ['resolution_submitted', 'resolved', 'closed'];

const actions = computed(() => {
  const issue = data.value?.issue;
  if (!issue || !auth.role) return [];
  return allowedIssueTransitions(issue.status, auth.role).map((to) => ({
    to,
    label: issue.status === 'resolution_submitted' && to === 'in_progress' ? 'Send back — not done yet' : issue.status === 'closed' || issue.status === 'resolved' ? (to === 'open' ? 'Reopen' : ACTION_LABEL[to]!) : ACTION_LABEL[to]!,
  }));
});
const managerOnlyHint = computed(() => {
  const s = data.value?.issue.status;
  return !isManager.value && s === 'resolution_submitted' ? `Waiting for your ${auth.terms.head} to confirm it’s done.` : null;
});
const photosFor = (updateId: string) => data.value?.photos.filter((p) => p.update_id === updateId) ?? [];
// Marking something done opens the note-and-photo dialog instead of the plain note dialog.
const markingDone = ref(false);
function choose(a: { to: IssueStatus; label: string }) {
  if (a.to === 'resolution_submitted') markingDone.value = true;
  else pending.value = a;
}
async function afterDone() {
  markingDone.value = false;
  await reload(true);
}

const pending = ref<{ to: IssueStatus; label: string } | null>(null);
const note = ref('');
const busy = ref(false);
async function transition() {
  if (!pending.value) return;
  busy.value = true;
  try {
    await api.post(`/issues/${id.value}/transition`, { to: pending.value.to, note: note.value });
    toast.ok(`Moved to ${ISSUE_STATUS_LABELS[pending.value.to]}`);
    pending.value = null;
    note.value = '';
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}

const update = ref('');
async function addNote() {
  if (update.value.trim().length < 3) return;
  busy.value = true;
  try {
    await api.post(`/issues/${id.value}/notes`, { note: update.value });
    update.value = '';
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}

async function assign(e: CustomEvent<{ value: string | null }>) {
  const value = e.detail.value || null;
  try {
    await api.post(`/issues/${id.value}/assign`, { assignee_id: value });
    toast.ok(value ? 'Assigned' : 'Unassigned');
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

const KIND_LABEL: Record<string, string> = {
  created: 'Created',
  status_change: 'Status changed',
  note: 'Update',
  report_update: 'From a shift endorsement',
  assignment: 'Assignment',
  escalation: 'Escalated',
};
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-3xl">
            <RouterLink :to="base" class="text-[13px] text-ink-3 hover:text-ink">← {{ auth.terms.issues }}</RouterLink>
            <StateBlock class="mt-3" :loading="loading" :error="error" :lines="5" @retry="reload()">
              <template v-if="data">
                <PageHeader class="mt-3" :eyebrow="data.issue.code" :title="data.issue.title">
                  <template #meta>
                    <div class="mt-2 flex flex-wrap items-center gap-3">
                      <StatusBadge :issue="data.issue.status" />
                      <SeverityTag :severity="data.issue.severity" :safety="data.issue.is_safety" />
                      <span v-if="data.issue.escalated_at" class="text-[13px] font-medium text-warn">Escalated {{ dateTime(data.issue.escalated_at) }}</span>
                    </div>
                  </template>
                </PageHeader>

                <div class="card p-5">
                  <p class="text-[14px] whitespace-pre-wrap" :class="data.issue.description ? '' : 'text-ink-3'">{{ data.issue.description || 'No description.' }}</p>
                  <dl class="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-[13px] sm:grid-cols-3">
                    <div><dt class="text-ink-3">Raised</dt><dd>{{ dateTime(data.issue.created_at) }}<template v-if="data.issue.created_by_name"> by {{ data.issue.created_by_name }}</template></dd></div>
                    <div>
                      <dt class="text-ink-3">Assignee</dt>
                      <dd v-if="isManager">
                        <IonSelect class="field-input mt-0.5 h-8 py-0 text-[13px]" :value="data.issue.assignee_id ?? ''" aria-label="Assignee" @ion-change="assign" interface="popover">
                          <IonSelectOption value="">Unassigned</IonSelectOption>
                          <IonSelectOption v-for="p in staff.data.value ?? []" :key="p.id" :value="p.id">{{ p.full_name }}</IonSelectOption>
                        </IonSelect>
                      </dd>
                      <dd v-else>{{ data.issue.assignee_name ?? 'Unassigned' }}</dd>
                    </div>
                    <div v-if="data.issue.resolved_at"><dt class="text-ink-3">Verified</dt><dd>{{ dateTime(data.issue.resolved_at) }} by {{ data.issue.resolved_by_name }}</dd></div>
                  </dl>
                  <div v-if="actions.length || managerOnlyHint" class="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                    <UiButton
                      v-for="a in actions"
                      :key="a.to"
                      :variant="a.to === 'resolved' || a.to === 'resolution_submitted' ? 'primary' : 'secondary'"
                      size="sm"
                      @click="choose(a)"
                    >
                      {{ a.label }}
                    </UiButton>
                    <p v-if="managerOnlyHint" class="text-[13px] text-ink-3">{{ managerOnlyHint }}</p>
                  </div>
                </div>

                <section class="mt-6">
                  <h2 class="text-[15px] font-semibold">History</h2>
                  <ol class="stagger mt-3 space-y-0">
                    <li v-for="u in data.updates" :key="u.id" class="relative border-l border-line pb-5 pl-5 last:pb-0">
                      <span class="absolute top-1.5 -left-[4.5px] size-2 rounded-full" :class="u.kind === 'escalation' ? 'bg-warn' : u.kind === 'status_change' ? 'bg-accent' : 'bg-line-strong'" />
                      <p class="text-[13px] text-ink-3 tnum">
                        {{ KIND_LABEL[u.kind] ?? u.kind }} · {{ dateTime(u.created_at) }}<template v-if="u.author_name"> · {{ u.author_name }}</template><template v-else> · System</template>
                      </p>
                      <p v-if="u.to_status" class="mt-0.5 text-[14px]">
                        <template v-if="u.from_status">{{ ISSUE_STATUS_LABELS[u.from_status] }} → </template><span class="font-medium">{{ ISSUE_STATUS_LABELS[u.to_status] }}</span>
                      </p>
                      <p v-if="u.note" class="mt-0.5 text-[14px] whitespace-pre-wrap text-ink-2">{{ u.note }}</p>
                      <div v-if="photosFor(u.id).length" class="mt-2 flex flex-wrap gap-2">
                        <IssuePhoto v-for="p in photosFor(u.id)" :key="p.id" :photo-id="p.id" :alt="`Photo from ${p.uploaded_by_name ?? 'staff'}`" />
                      </div>
                    </li>
                  </ol>
                  <form v-if="!['closed'].includes(data.issue.status)" class="mt-5 flex flex-col gap-2 sm:flex-row" @submit.prevent="addNote">
                    <IonInput v-model="update" class="field-input" placeholder="Add an update for the next shift" :maxlength="2000" aria-label="Add an update"  />
                    <UiButton type="submit" :disabled="update.trim().length < 3" :loading="busy && !pending">Add update</UiButton>
                  </form>
                </section>
              </template>
            </StateBlock>

            <MarkDoneDialog :issue="markingDone && data ? data.issue : null" @close="markingDone = false" @done="afterDone" />

            <UiDialog
              :open="Boolean(pending)"
              :title="pending?.label ?? ''"
              :description="pending?.to === 'resolution_submitted' ? `Your ${auth.terms.head} will verify it before it is marked resolved.` : pending?.to === 'resolved' ? 'Confirm you verified the resolution yourself or against a record.' : undefined"
              @close="pending = null"
            >
              <UiField v-slot="{ id: fid, labelledby }" :label="pending && NOTE_REQUIRED.includes(pending.to) ? 'Note (required)' : 'Note'">
                <IonTextarea :id="fid" :aria-labelledby="labelledby" v-model="note" class="field-input" :rows="3" :placeholder="pending?.to === 'resolved' ? 'How was it verified?' : 'What was done?'"  auto-grow />
              </UiField>
              <template #footer>
                <UiButton variant="ghost" @click="pending = null">Cancel</UiButton>
                <UiButton variant="primary" :loading="busy" :disabled="Boolean(pending && NOTE_REQUIRED.includes(pending.to) && note.trim().length < 3)" @click="transition">Confirm</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
