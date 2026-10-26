<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { DEMO_SAMPLE_REPORT, EMPTY_REPORT, ReportDraftContent, ReportSubmission, type IssueUpdateInput } from '@sh/shared';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { time } from '@/lib/format';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

const props = defineProps<{
  reportId: string;
  initial: unknown;
  serverUpdatedAt: string;
  isRevision: boolean;
  canSubmit: boolean;
  submitBlockedReason: string | null;
  openIssues: { id: string; code: string; title: string; status: string }[];
}>();
const emit = defineEmits<{ submitted: [] }>();

const auth = useAuth();
const toast = useToast();
const backupKey = `sh.draft.${props.reportId}`;

function parse(raw: unknown): ReportDraftContent {
  const r = ReportDraftContent.safeParse(raw ?? {});
  return r.success ? r.data : { ...EMPTY_REPORT };
}

const content = ref<ReportDraftContent>(parse(props.initial));
const errors = ref<Record<string, string>>({});
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const savedAt = ref<string | null>(null);
const showMore = ref(Boolean(content.value.operational_concerns || content.value.handover_notes || content.value.evidence_refs));
const showIssues = ref(content.value.issue_updates.length > 0);
const confirming = ref(false);
const submitting = ref(false);

// A local copy protects against losing text if the network drops before the server save.
const backup = ref<{ content: ReportDraftContent; at: string } | null>(null);
try {
  const raw = localStorage.getItem(backupKey);
  if (raw) {
    const b = JSON.parse(raw) as { content: unknown; at: string };
    const parsed = parse(b.content);
    if (new Date(b.at) > new Date(props.serverUpdatedAt) && JSON.stringify(parsed) !== JSON.stringify(content.value)) {
      backup.value = { content: parsed, at: b.at };
    } else localStorage.removeItem(backupKey);
  }
} catch {
  /* storage unavailable */
}

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
async function save() {
  if (!dirty) return;
  dirty = false;
  saveState.value = 'saving';
  try {
    const res = await api.put<{ saved_at: string }>(`/reports/${props.reportId}/draft`, { content: content.value });
    savedAt.value = res.saved_at;
    saveState.value = 'saved';
    try {
      localStorage.removeItem(backupKey);
    } catch {
      /* ignore */
    }
  } catch (err) {
    saveState.value = 'error';
    dirty = true;
    if (err instanceof ApiError && err.status === 409) toast.error(err.message);
  }
}

watch(
  content,
  () => {
    dirty = true;
    try {
      localStorage.setItem(backupKey, JSON.stringify({ content: content.value, at: new Date().toISOString() }));
    } catch {
      /* ignore */
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), 1200);
  },
  { deep: true },
);
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  void save();
});

function restoreBackup() {
  if (backup.value) content.value = backup.value.content;
  backup.value = null;
}
function discardBackup() {
  backup.value = null;
  try {
    localStorage.removeItem(backupKey);
  } catch {
    /* ignore */
  }
}

function useSample() {
  content.value = structuredClone(DEMO_SAMPLE_REPORT);
  showMore.value = true;
}

const updatesById = computed(() => new Map(content.value.issue_updates.map((u) => [u.issue_id, u])));
function toggleIssue(id: string, on: boolean) {
  if (on) content.value.issue_updates.push({ issue_id: id, note: '', claimed_status: 'still_open' } satisfies IssueUpdateInput);
  else content.value.issue_updates = content.value.issue_updates.filter((u) => u.issue_id !== id);
}

function validate(): boolean {
  const r = ReportSubmission.safeParse(content.value);
  errors.value = {};
  if (r.success) return true;
  for (const issue of r.error.issues) {
    const key = issue.path.join('.');
    if (!errors.value[key]) errors.value[key] = issue.message;
  }
  if (Object.keys(errors.value).some((k) => k.startsWith('issue_updates'))) showIssues.value = true;
  return false;
}

function requestSubmit() {
  if (!validate()) {
    toast.error('Some required details are missing');
    return;
  }
  confirming.value = true;
}

async function submit() {
  submitting.value = true;
  try {
    if (timer) clearTimeout(timer);
    await api.post(`/reports/${props.reportId}/submit`, { content: content.value });
    dirty = false;
    try {
      localStorage.removeItem(backupKey);
    } catch {
      /* ignore */
    }
    confirming.value = false;
    toast.ok('Report submitted. Your supervisor will verify it before it is handed over.');
    emit('submitted');
  } catch (err) {
    if (err instanceof ApiError && err.fields) {
      errors.value = err.fields;
    }
    confirming.value = false;
    toast.error(errorMessage(err));
  } finally {
    submitting.value = false;
  }
}

const saveLabel = computed(() => {
  if (saveState.value === 'saving') return 'Saving…';
  if (saveState.value === 'error') return 'Not saved — will retry';
  if (saveState.value === 'saved' && savedAt.value) return `Saved ${time(savedAt.value)}`;
  return 'Changes save automatically';
});
</script>

<template>
  <div>
    <div v-if="backup" class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-[14px]">
      <span class="text-info">This device has unsaved changes from {{ time(backup.at) }}.</span>
      <span class="flex gap-2">
        <UiButton size="sm" variant="primary" @click="restoreBackup">Restore</UiButton>
        <UiButton size="sm" variant="ghost" @click="discardBackup">Discard</UiButton>
      </span>
    </div>

    <div v-if="auth.config?.demo" class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-dashed border-line-strong px-4 py-2.5 text-[13px] text-ink-2">
      <span>Demo: fill the form with a synthetic messy report (names, a phone number, a repair claim and an injection attempt).</span>
      <UiButton size="sm" variant="ghost" @click="useSample">Use sample</UiButton>
    </div>

    <form class="space-y-6" novalidate @submit.prevent="requestSubmit">
      <UiField
        v-slot="{ id, invalid, describedby }"
        label="Completed work"
        hint="What did you finish? Include quantities and reference numbers exactly as recorded."
        :error="errors.completed_work"
      >
        <textarea :id="id" v-model="content.completed_work" class="field-input min-h-28" rows="4" :aria-invalid="invalid" :aria-describedby="describedby" />
      </UiField>

      <UiField
        v-slot="{ id, invalid, describedby }"
        label="Unresolved issues"
        hint="Problems still open at the end of your shift — where, what you saw, and what was done so far."
        :error="errors.unresolved_issues"
      >
        <textarea
          :id="id"
          v-model="content.unresolved_issues"
          class="field-input min-h-24"
          rows="3"
          :disabled="content.no_unresolved_issues"
          :aria-invalid="invalid"
          :aria-describedby="describedby"
        />
        <label class="mt-2 flex items-center gap-2 text-[14px] text-ink-2">
          <input v-model="content.no_unresolved_issues" type="checkbox" class="size-4 accent-accent" @change="content.no_unresolved_issues && (content.unresolved_issues = '')" />
          There are no unresolved issues
        </label>
      </UiField>

      <UiField v-slot="{ id, invalid, describedby }" label="Pending tasks" hint="Work the next shift needs to pick up." :error="errors.pending_tasks">
        <textarea
          :id="id"
          v-model="content.pending_tasks"
          class="field-input min-h-24"
          rows="3"
          :disabled="content.no_pending_tasks"
          :aria-invalid="invalid"
          :aria-describedby="describedby"
        />
        <label class="mt-2 flex items-center gap-2 text-[14px] text-ink-2">
          <input v-model="content.no_pending_tasks" type="checkbox" class="size-4 accent-accent" @change="content.no_pending_tasks && (content.pending_tasks = '')" />
          There are no pending tasks
        </label>
      </UiField>

      <div class="rounded-lg border border-line">
        <button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left" :aria-expanded="showMore" @click="showMore = !showMore">
          <span>
            <span class="block text-[14px] font-medium">Concerns, notes and evidence</span>
            <span class="block text-[13px] text-ink-3">Safety or equipment concerns, notes for the next shift, photo or document references</span>
          </span>
          <span class="text-[13px] text-ink-3">{{ showMore ? 'Hide' : 'Add' }}</span>
        </button>
        <div v-if="showMore" class="space-y-5 border-t border-line px-4 py-4">
          <UiField v-slot="{ id }" label="Operational concerns" hint="Safety, equipment, staffing or supply concerns — even if unconfirmed." optional>
            <textarea :id="id" v-model="content.operational_concerns" class="field-input" rows="3" />
          </UiField>
          <UiField v-slot="{ id }" label="Handover notes" hint="Anything else the incoming shift should know." optional>
            <textarea :id="id" v-model="content.handover_notes" class="field-input" rows="3" />
          </UiField>
          <UiField v-slot="{ id }" label="Evidence references" hint="Work order numbers, photo references, log entries." optional>
            <input :id="id" v-model="content.evidence_refs" class="field-input" />
          </UiField>
        </div>
      </div>

      <div v-if="openIssues.length" class="rounded-lg border border-line">
        <button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left" :aria-expanded="showIssues" @click="showIssues = !showIssues">
          <span>
            <span class="block text-[14px] font-medium">Updates on open issues</span>
            <span class="block text-[13px] text-ink-3">{{ openIssues.length }} open in your department · {{ content.issue_updates.length }} updated in this report</span>
          </span>
          <span class="text-[13px] text-ink-3">{{ showIssues ? 'Hide' : 'Show' }}</span>
        </button>
        <ul v-if="showIssues" class="divide-y divide-line border-t border-line">
          <li v-for="issue in openIssues" :key="issue.id" class="px-4 py-3">
            <label class="flex items-start gap-3">
              <input
                type="checkbox"
                class="mt-1 size-4 accent-accent"
                :checked="updatesById.has(issue.id)"
                @change="toggleIssue(issue.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="min-w-0">
                <span class="block text-[14px] font-medium">{{ issue.title }}</span>
                <span class="block text-[12.5px] text-ink-3 tnum">{{ issue.code }} · {{ issue.status.replace(/_/g, ' ') }}</span>
              </span>
            </label>
            <div v-if="updatesById.get(issue.id)" class="mt-3 grid gap-3 pl-7 sm:grid-cols-[180px_1fr]">
              <select v-model="updatesById.get(issue.id)!.claimed_status" class="field-input" aria-label="Status you observed">
                <option value="still_open">Still open</option>
                <option value="in_progress">Being worked on</option>
                <option value="addressed">I think it’s addressed</option>
              </select>
              <div>
                <input
                  v-model="updatesById.get(issue.id)!.note"
                  class="field-input"
                  placeholder="What did you see or do?"
                  :aria-invalid="Boolean(errors[`issue_updates.${content.issue_updates.findIndex((u) => u.issue_id === issue.id)}.note`])"
                />
                <p v-if="updatesById.get(issue.id)!.claimed_status === 'addressed'" class="mt-1 text-[12.5px] text-ink-3">
                  A supervisor still has to verify it before it is marked resolved.
                </p>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-lg sm:border sm:bg-surface">
        <p class="text-[13px] text-ink-3" :class="{ 'text-bad': saveState === 'error' }" aria-live="polite">{{ saveLabel }}</p>
        <div class="flex flex-col gap-1 sm:items-end">
          <UiButton type="submit" variant="primary" size="lg" :disabled="!canSubmit" :loading="submitting">
            {{ isRevision ? 'Submit revision' : 'Submit report' }}
          </UiButton>
          <p v-if="!canSubmit && submitBlockedReason" class="text-[12.5px] text-ink-3">{{ submitBlockedReason }}</p>
        </div>
      </div>
    </form>

    <UiDialog :open="confirming" title="Submit this report?" @close="confirming = false">
      <p class="text-[14px] text-ink-2">
        After you submit, you can’t edit it unless your supervisor asks for a revision. Before analysis, names and personal details
        are replaced or removed. Nothing is handed over until your supervisor verifies it.
      </p>
      <template #footer>
        <UiButton variant="ghost" @click="confirming = false">Keep editing</UiButton>
        <UiButton variant="primary" :loading="submitting" @click="submit">Submit</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
