<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DEMO_SAMPLE_REPORT,
  GENERIC_SAMPLE_REPORT,
  EMPTY_REPORT,
  PROBLEM_CATEGORIES,
  PROBLEM_CATEGORY_LABELS,
  ReportDraftContent,
  ReportSubmission,
  type IssueUpdateInput,
  type ProblemInput,
} from '@sh/shared';
import UiButton from '@/components/ui/UiButton.vue';
import { openWorkAssistant } from '@/lib/assistant';
import UiDialog from '@/components/ui/UiDialog.vue';
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
  /**
   * Admin AI pipeline: the same form and checks as a real report, but nothing is saved and the
   * button hands the answers to the pipeline preview instead of submitting them.
   */
  preview?: boolean;
  previewBusy?: boolean;
}>();
const emit = defineEmits<{ submitted: []; preview: [content: ReportDraftContent] }>();

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
const confirming = ref(false);
const submitting = ref(false);
const showMore = ref(Boolean(content.value.operational_concerns || content.value.handover_notes || content.value.evidence_refs));
const showParagraph = ref(Boolean(content.value.unresolved_issues));

// ---- Autosave, with a copy on this device in case the network drops ----------------
const backup = ref<{ content: ReportDraftContent; at: string } | null>(null);
try {
  const raw = props.preview ? null : localStorage.getItem(backupKey);
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
  if (!dirty || props.preview) return;
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
    if (props.preview) return;
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
  content.value = structuredClone(auth.experience.industry === 'Newborn care operations' ? DEMO_SAMPLE_REPORT : GENERIC_SAMPLE_REPORT);
  showMore.value = true;
}

// ---- Question 2: problems still open ------------------------------------------------
const problemsAnswer = computed<'yes' | 'no' | null>(() =>
  content.value.no_unresolved_issues ? 'no' : content.value.problems.length || content.value.unresolved_issues || adding.value ? 'yes' : null,
);
const adding = ref<(ProblemInput & { index: number | null }) | null>(null);
function answerProblems(answer: 'yes' | 'no') {
  if (answer === 'no') {
    if (content.value.problems.length) {
      confirmingNoProblems.value = true;
      return;
    }
    clearProblems();
  } else {
    content.value.no_unresolved_issues = false;
    if (!content.value.problems.length) startProblem();
  }
}
/** Asked before "No problems" removes problems the worker already listed. */
const confirmingNoProblems = ref(false);
function clearProblems() {
  confirmingNoProblems.value = false;
  content.value.problems = [];
  content.value.unresolved_issues = '';
  content.value.no_unresolved_issues = true;
  adding.value = null;
}
function startProblem(index: number | null = null) {
  const p = index === null ? { category: 'equipment' as const, location: '', what: '' } : content.value.problems[index]!;
  adding.value = { ...p, index };
}
function saveProblem() {
  const a = adding.value!;
  if (a.what.trim().length < 3) {
    errors.value = { ...errors.value, adding: 'Say what happened' };
    return;
  }
  const item: ProblemInput = { category: a.category, location: a.location.trim(), what: a.what.trim() };
  if (a.index === null) content.value.problems.push(item);
  else content.value.problems[a.index] = item;
  content.value.no_unresolved_issues = false;
  adding.value = null;
  delete errors.value.adding;
  delete errors.value.unresolved_issues;
}

// ---- Question 3: earlier problems -----------------------------------------------------
const updatesById = computed(() => new Map(content.value.issue_updates.map((u) => [u.issue_id, u])));
function setIssueStatus(id: string, status: IssueUpdateInput['claimed_status']) {
  const existing = updatesById.value.get(id);
  if (existing?.claimed_status === status) {
    content.value.issue_updates = content.value.issue_updates.filter((u) => u.issue_id !== id);
  } else if (existing) existing.claimed_status = status;
  else content.value.issue_updates.push({ issue_id: id, claimed_status: status, note: '' });
}
const ISSUE_CHOICES: { value: IssueUpdateInput['claimed_status']; label: string }[] = [
  { value: 'still_open', label: 'Still there' },
  { value: 'in_progress', label: 'Being fixed' },
  { value: 'addressed', label: 'Fixed' },
];

// ---- Question 4: for the next shift ---------------------------------------------------
const tasksAnswer = computed<'yes' | 'no' | null>(() => (content.value.no_pending_tasks ? 'no' : content.value.pending_tasks || tasksOpen.value ? 'yes' : null));
const tasksOpen = ref(false);
function answerTasks(answer: 'yes' | 'no') {
  content.value.no_pending_tasks = answer === 'no';
  tasksOpen.value = answer === 'yes';
  if (answer === 'no') content.value.pending_tasks = '';
}

// ---- Submit ------------------------------------------------------------------------------
function validate(): boolean {
  const r = ReportSubmission.safeParse(content.value);
  errors.value = {};
  if (r.success) return true;
  for (const issue of r.error.issues) {
    const key = issue.path.join('.');
    if (!errors.value[key]) errors.value[key] = issue.message;
  }
  document.querySelector('[data-error="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}
function requestSubmit() {
  if (adding.value) saveProblem();
  if (!validate()) {
    toast.error('A few answers are missing');
    return;
  }
  if (props.preview) {
    emit('preview', JSON.parse(JSON.stringify(content.value)) as ReportDraftContent);
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
    toast.ok('Report sent. Your supervisor will check it before the next shift gets it.');
    emit('submitted');
  } catch (err) {
    if (err instanceof ApiError && err.fields) errors.value = err.fields;
    confirming.value = false;
    toast.error(errorMessage(err));
  } finally {
    submitting.value = false;
  }
}

const saveLabel = computed(() => {
  if (props.preview) return 'Example only — nothing is saved or sent to anyone';
  if (saveState.value === 'saving') return 'Saving…';
  if (saveState.value === 'error') return 'Not saved yet — will retry';
  if (saveState.value === 'saved' && savedAt.value) return `Saved ${time(savedAt.value)}`;
  return 'Saves automatically';
});
const coreProgress = computed(() => {
  const completed = [
    content.value.completed_work.trim().length >= 3,
    problemsAnswer.value === 'no' || (problemsAnswer.value === 'yes' && (content.value.problems.length > 0 || content.value.unresolved_issues.trim().length >= 3)),
    tasksAnswer.value === 'no' || (tasksAnswer.value === 'yes' && content.value.pending_tasks.trim().length >= 3),
  ].filter(Boolean).length;
  return { completed, total: 3, percent: Math.round((completed / 3) * 100) };
});
const issueNoteError = (id: string) => errors.value[`issue_updates.${content.value.issue_updates.findIndex((u) => u.issue_id === id)}.note`];
const choice = (active: boolean) =>
  active ? 'border-accent bg-accent text-white font-medium shadow-sm before:mr-1.5 before:content-["✓"]' : 'border-line-strong bg-surface text-ink hover:bg-sunken';
</script>

<template>
  <div>
    <button v-if="!preview" type="button" class="mb-4 text-[13px] font-medium text-accent hover:underline" @click="openWorkAssistant">Prepare this {{ auth.experience.report_label.toLowerCase() }} with Mica ↗</button>
    <div v-if="backup" class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-info/25 bg-info-soft px-4 py-3 text-[14px]">
      <span class="text-info">This device has unsaved changes from {{ time(backup.at) }}.</span>
      <span class="flex gap-2">
        <UiButton size="sm" variant="primary" @click="restoreBackup">Restore</UiButton>
        <UiButton size="sm" variant="ghost" @click="discardBackup">Discard</UiButton>
      </span>
    </div>

    <div v-if="auth.config?.demo || preview" class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-dashed border-line-strong px-4 py-2.5 text-[13px] text-ink-2">
      <span>Not sure what to write? Fill the form with an example report, then edit it.</span>
      <UiButton size="sm" variant="ghost" @click="useSample">Generate example</UiButton>
    </div>

    <div class="card mb-4 px-4 py-3.5 sm:px-5">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-[13.5px] font-semibold">Report progress</p>
          <p class="mt-0.5 text-[12.5px] text-ink-3">Answer the three main questions. Earlier issues are optional unless you checked them.</p>
        </div>
        <span class="shrink-0 text-[13px] font-medium text-ink-2 tnum">{{ coreProgress.completed }}/{{ coreProgress.total }}</span>
      </div>
      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" :aria-valuenow="coreProgress.completed" :aria-valuemax="coreProgress.total" aria-label="Report completion">
        <div class="h-full rounded-full bg-accent transition-all" :style="{ width: `${coreProgress.percent}%` }" />
      </div>
      <p class="mt-2 text-[12px] text-ink-3">{{ auth.experience.privacy_hint }}</p>
    </div>

    <form class="space-y-4" novalidate @submit.prevent="requestSubmit">
      <!-- 1. Work completed -->
      <section class="card p-5" :data-error="Boolean(errors.completed_work)">
        <h3 class="text-[16px] font-semibold"><span class="mr-2 text-ink-3 tnum">1</span>What did you finish this shift?</h3>
        <p class="mt-1 text-[13.5px] text-ink-3">{{ auth.experience.completed_hint }}</p>
        <textarea
          v-model="content.completed_work"
          class="field-input mt-3 min-h-24"
          rows="3"
          :placeholder="auth.experience.completed_hint"
          aria-label="What did you finish this shift?"
          :aria-invalid="Boolean(errors.completed_work)"
        />
        <p v-if="errors.completed_work" class="mt-1.5 text-[13px] text-bad">{{ errors.completed_work }}</p>
      </section>

      <!-- 2. New unresolved issues -->
      <section class="card p-5" :data-error="Boolean(errors.unresolved_issues)">
        <h3 class="text-[16px] font-semibold"><span class="mr-2 text-ink-3 tnum">2</span>Any {{ auth.experience.issue_label.toLowerCase() }} to hand over?</h3>
        <p class="mt-1 text-[13.5px] text-ink-3">{{ auth.experience.unresolved_hint }} Each item is tracked after review.</p>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button type="button" class="h-12 rounded-md border text-[15px] transition-colors" :class="choice(problemsAnswer === 'yes')" @click="answerProblems('yes')">Add a issue</button>
          <button type="button" class="h-12 rounded-md border text-[15px] transition-colors" :class="choice(problemsAnswer === 'no')" @click="answerProblems('no')">No new issues</button>
        </div>

        <template v-if="problemsAnswer === 'yes'">
          <ul v-if="content.problems.length" class="mt-4 space-y-2">
            <li v-for="(p, i) in content.problems" :key="i" class="flex items-start gap-3 rounded-md border border-line px-3.5 py-2.5" :class="{ 'border-bad/40 bg-bad-soft/40': p.category === 'safety' }">
              <div class="min-w-0 flex-1">
                <p class="text-[12.5px] font-medium" :class="p.category === 'safety' ? 'text-bad' : 'text-ink-2'">
                  {{ PROBLEM_CATEGORY_LABELS[p.category] }}<template v-if="p.location"> · {{ p.location }}</template>
                </p>
                <p class="text-[14px]">{{ p.what }}</p>
                <p v-if="errors[`problems.${i}.what`]" class="text-[13px] text-bad">{{ errors[`problems.${i}.what`] }}</p>
              </div>
              <button type="button" class="text-[13px] text-ink-3 hover:text-ink" @click="startProblem(i)">Edit</button>
              <button type="button" class="text-[13px] text-ink-3 hover:text-bad" @click="content.problems.splice(i, 1)">Remove</button>
            </li>
          </ul>

          <div v-if="adding" class="mt-4 rounded-md border border-accent/40 bg-canvas p-4">
            <p class="text-[13.5px] font-medium">New handover issue</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button
                v-for="c in auth.experience.categories"
                :key="c"
                type="button"
                class="rounded-full border px-3 py-1.5 text-[13.5px]"
                :class="adding.category === c ? (c === 'safety' ? 'border-bad bg-bad text-white' : 'border-ink bg-ink text-white') : 'border-line-strong bg-surface text-ink-2 hover:bg-sunken'"
                @click="adding.category = c"
              >
                {{ PROBLEM_CATEGORY_LABELS[c] }}
              </button>
            </div>
            <label class="mt-3 block text-[13.5px] font-medium">
              Where? <span class="font-normal text-ink-3">(optional)</span>
              <input v-model="adding.location" class="field-input mt-1" maxlength="120" placeholder="Area, room, equipment or service reference" />
            </label>
            <label class="mt-3 block text-[13.5px] font-medium">
              What happened?
              <textarea v-model="adding.what" class="field-input mt-1" rows="2" maxlength="600" placeholder="Describe what you observed and what action you took" :aria-invalid="Boolean(errors.adding)" />
            </label>
            <p v-if="errors.adding" class="mt-1 text-[13px] text-bad">{{ errors.adding }}</p>
            <div class="mt-3 flex gap-2">
              <UiButton size="sm" variant="primary" @click="saveProblem">{{ adding.index === null ? 'Add issue' : 'Save' }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="adding = null">Cancel</UiButton>
            </div>
          </div>
          <UiButton v-else class="mt-3" size="sm" @click="startProblem()">+ Add {{ content.problems.length ? 'another' : 'a' }} issue</UiButton>

          <div class="mt-3">
            <button v-if="!showParagraph" type="button" class="text-[13px] text-ink-3 hover:text-ink" @click="showParagraph = true">Prefer to write it as a paragraph?</button>
            <textarea v-else v-model="content.unresolved_issues" class="field-input mt-1" rows="3" placeholder="Anything else about the open problems" aria-label="More about the open problems" />
          </div>
        </template>
        <p v-if="errors.unresolved_issues" class="mt-2 text-[13px] text-bad">{{ errors.unresolved_issues }}</p>
      </section>

      <!-- Existing issues stay out of the main path unless the employee checked one. -->
      <details v-if="openIssues.length" class="card overflow-hidden">
        <summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4">
          <span>
            <span class="block text-[16px] font-semibold"><span class="mr-2 text-ink-3 tnum">3</span>Update an existing issue <span class="font-normal text-ink-3">(optional)</span></span>
            <span class="mt-1 block text-[13px] text-ink-3">Open this only if you personally checked an earlier issue.</span>
          </span>
          <span class="shrink-0 text-[12.5px] text-ink-3">{{ openIssues.length }} open</span>
        </summary>
        <div class="border-t border-line px-5 py-4">
          <p class="text-[13.5px] text-ink-3">Choose what you observed. “Fixed” still needs your supervisor’s confirmation.</p>
          <ul class="mt-3 divide-y divide-line">
          <li v-for="issue in openIssues" :key="issue.id" class="py-3 first:pt-0 last:pb-0">
            <p class="text-[14px] font-medium">{{ issue.title }} <span class="font-normal text-ink-3 tnum">· {{ issue.code }}</span></p>
            <div class="mt-2 grid grid-cols-3 gap-1.5">
              <button
                v-for="c in ISSUE_CHOICES"
                :key="c.value"
                type="button"
                class="h-10 rounded-md border text-[13.5px]"
                :class="choice(updatesById.get(issue.id)?.claimed_status === c.value)"
                @click="setIssueStatus(issue.id, c.value)"
              >
                {{ c.label }}
              </button>
            </div>
            <input
              v-if="updatesById.get(issue.id)"
              v-model="updatesById.get(issue.id)!.note"
              class="field-input mt-2"
              maxlength="1000"
              :placeholder="updatesById.get(issue.id)!.claimed_status === 'addressed' ? 'What did you do to fix it?' : 'Anything to add? (optional)'"
              :aria-invalid="Boolean(issueNoteError(issue.id))"
            />
            <p v-if="issueNoteError(issue.id)" class="mt-1 text-[13px] text-bad">{{ issueNoteError(issue.id) }}</p>
          </li>
          </ul>
        </div>
      </details>

      <!-- 4. Next shift -->
      <section class="card p-5" :data-error="Boolean(errors.pending_tasks)">
        <h3 class="text-[16px] font-semibold"><span class="mr-2 text-ink-3 tnum">{{ openIssues.length ? 4 : 3 }}</span>Anything the next shift must do?</h3>
        <p class="mt-1 text-[13.5px] text-ink-3">Each one becomes a checklist item for them.</p>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button type="button" class="h-12 rounded-md border text-[15px]" :class="choice(tasksAnswer === 'yes')" @click="answerTasks('yes')">Yes</button>
          <button type="button" class="h-12 rounded-md border text-[15px]" :class="choice(tasksAnswer === 'no')" @click="answerTasks('no')">Nothing</button>
        </div>
        <textarea
          v-if="tasksAnswer === 'yes'"
          v-model="content.pending_tasks"
          class="field-input mt-3"
          rows="3"
          :placeholder="auth.experience.pending_hint"
          aria-label="What the next shift must do"
          :aria-invalid="Boolean(errors.pending_tasks)"
        />
        <p v-if="errors.pending_tasks" class="mt-1.5 text-[13px] text-bad">{{ errors.pending_tasks }}</p>
      </section>

      <!-- Optional extras -->
      <section class="card">
        <button type="button" class="flex w-full items-center justify-between px-5 py-4 text-left" :aria-expanded="showMore" @click="showMore = !showMore">
          <span>
            <span class="block text-[15px] font-medium">Anything else? <span class="font-normal text-ink-3">(optional)</span></span>
            <span class="block text-[13px] text-ink-3">Equipment or safety worries, notes, photo references</span>
          </span>
          <span class="text-[13px] text-ink-3">{{ showMore ? 'Hide' : 'Add' }}</span>
        </button>
        <div v-if="showMore" class="space-y-3 border-t border-line px-5 py-4">
          <label class="block text-[13.5px] font-medium">Equipment or safety worries
            <textarea v-model="content.operational_concerns" class="field-input mt-1" rows="2" :placeholder="auth.experience.concerns_hint" />
          </label>
          <label class="block text-[13.5px] font-medium">Other notes
            <textarea v-model="content.handover_notes" class="field-input mt-1" rows="2" />
          </label>
          <label class="block text-[13.5px] font-medium">Photo or work-order references
            <input v-model="content.evidence_refs" class="field-input mt-1" maxlength="500" />
          </label>
        </div>
      </section>

      <div class="report-actions sticky -mx-4 flex flex-col gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:rounded-lg sm:border sm:bg-surface">
        <p class="text-[13px] text-ink-3" :class="{ 'text-bad': saveState === 'error' }" aria-live="polite">{{ saveLabel }}</p>
        <div class="flex flex-col gap-1 sm:items-end">
          <UiButton type="submit" variant="primary" size="lg" :disabled="!canSubmit" :loading="submitting || previewBusy" block>
            {{ preview ? 'Run through the pipeline' : isRevision ? 'Send revision' : 'Send report' }}
          </UiButton>
          <p v-if="!canSubmit && submitBlockedReason" class="text-[12.5px] text-ink-3">{{ submitBlockedReason }}</p>
        </div>
      </div>
    </form>

    <UiDialog
      :open="confirmingNoProblems"
      title="Remove the problems you listed?"
      :description="`You added ${content.problems.length} problem${content.problems.length === 1 ? '' : 's'}. Answering “No” removes them from this report.`"
      @close="confirmingNoProblems = false"
    >
      <template #footer>
        <UiButton variant="ghost" @click="confirmingNoProblems = false">Keep them</UiButton>
        <UiButton variant="danger" @click="clearProblems">Remove</UiButton>
      </template>
    </UiDialog>

    <UiDialog :open="confirming" title="Send this report?" @close="confirming = false">
      <p class="text-[14px] text-ink-2">
        You can’t edit it after sending unless your supervisor asks for changes. Names and personal details are removed before the
        draft is prepared, and nothing reaches the next shift until your supervisor checks it.
      </p>
      <template #footer>
        <UiButton variant="ghost" @click="confirming = false">Keep editing</UiButton>
        <UiButton variant="primary" :loading="submitting" @click="submit">Send</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
