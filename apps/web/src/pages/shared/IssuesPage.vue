<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ISSUE_SEVERITIES, type IssueSeverity } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import SeverityTag from '@/components/ui/SeverityTag.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import type { IssueRow } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

const auth = useAuth();
const toast = useToast();
const router = useRouter();
const isManager = computed(() => auth.role === 'manager');
const base = computed(() => (isManager.value ? '/manager/issues' : '/tasks'));

type Scope = 'active' | 'mine' | 'verification' | 'all';
const scope = ref<Scope>('active');
const tabs = computed<{ key: Scope; label: string }[]>(() => [
  { key: 'active', label: 'Active' },
  isManager.value ? { key: 'verification', label: 'Needs verification' } : { key: 'mine', label: 'Assigned to me' },
  { key: 'all', label: 'All' },
]);
const { data, loading, refreshing, error, reload } = useAsync(() => api.get<IssueRow[]>(`/issues?scope=${scope.value}`), [scope]);

const raising = ref(false);
const form = ref({ title: '', description: '', severity: 'medium' as IssueSeverity, is_safety: false });
const formErrors = ref<Record<string, string>>({});
const saving = ref(false);
async function raise() {
  saving.value = true;
  formErrors.value = {};
  try {
    const res = await api.post<{ id: string; code: string; status: string }>('/issues', form.value);
    raising.value = false;
    toast.ok(isManager.value ? `${res.code} opened` : `${res.code} reported. A supervisor will review it.`);
    router.push(`${base.value}/${res.id}`);
  } catch (err) {
    if (err instanceof ApiError) formErrors.value = err.fields;
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader
      :title="isManager ? 'Issues' : 'Open issues'"
      description="Unresolved problems carry over from shift to shift until an authorized person verifies they are resolved."
    >
      <UiButton variant="primary" @click="raising = true">Report an issue</UiButton>
    </PageHeader>

    <div class="mb-4 flex gap-1 border-b border-line" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.key"
        role="tab"
        :aria-selected="scope === t.key"
        class="-mb-px border-b-2 px-3 py-2 text-[14px]"
        :class="scope === t.key ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-3 hover:text-ink'"
        @click="scope = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :empty="!data?.length" empty-title="No issues in this view" @retry="reload()">
      <div class="card overflow-hidden">
        <table class="w-full text-left text-[14px]">
          <thead class="hidden border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase sm:table-header-group">
            <tr>
              <th class="px-5 py-2.5 font-medium">Issue</th>
              <th class="px-3 py-2.5 font-medium">Severity</th>
              <th class="px-3 py-2.5 font-medium">Assignee</th>
              <th class="px-3 py-2.5 font-medium">Last update</th>
              <th class="px-5 py-2.5 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line">
            <tr v-for="i in data" :key="i.id" class="cursor-pointer hover:bg-canvas" @click="router.push(`${base}/${i.id}`)">
              <td class="px-5 py-3">
                <RouterLink :to="`${base}/${i.id}`" class="font-medium hover:underline" @click.stop>{{ i.title }}</RouterLink>
                <p class="text-[12.5px] text-ink-3 tnum">
                  <span v-if="i.kind === 'task'" class="mr-1.5 rounded-sm bg-info-soft px-1.5 py-px text-[11px] font-medium text-info">Task</span>{{ i.code }}<span v-if="i.escalated_at" class="ml-2 font-medium text-warn">Escalated</span>
                </p>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
                  <SeverityTag :severity="i.severity" :safety="i.is_safety" /><StatusBadge :issue="i.status" />
                </div>
              </td>
              <td class="hidden px-3 py-3 sm:table-cell"><SeverityTag :severity="i.severity" :safety="i.is_safety" /></td>
              <td class="hidden px-3 py-3 text-ink-2 sm:table-cell">{{ i.assignee_name ?? '—' }}</td>
              <td class="hidden px-3 py-3 text-ink-3 sm:table-cell">{{ relative(i.last_activity_at) }}</td>
              <td class="hidden px-5 py-3 text-right sm:table-cell"><StatusBadge :issue="i.status" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <UiDialog :open="raising" title="Report an issue" :description="isManager ? 'It opens immediately for your department.' : 'A supervisor reviews new issues before they are opened.'" @close="raising = false">
      <form id="raise-form" class="space-y-4" @submit.prevent="raise">
        <UiField v-slot="{ id }" label="What’s the problem?" :error="formErrors.title">
          <input :id="id" v-model="form.title" class="field-input" maxlength="160" placeholder="e.g. Dock 2 leveler not lowering" />
        </UiField>
        <UiField v-slot="{ id }" label="Details" optional>
          <textarea :id="id" v-model="form.description" class="field-input" rows="3" placeholder="Where, what you saw, what you did" />
        </UiField>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Severity">
            <select :id="id" v-model="form.severity" class="field-input capitalize">
              <option v-for="s in ISSUE_SEVERITIES" :key="s" :value="s">{{ s }}</option>
            </select>
          </UiField>
          <label class="mt-7 flex items-center gap-2 text-[14px]">
            <input v-model="form.is_safety" type="checkbox" class="size-4 accent-accent" /> Safety concern
          </label>
        </div>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="raising = false">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="raise-form" :loading="saving">Report issue</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
