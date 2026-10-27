<script setup lang="ts">
import { ref } from 'vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * Organisation-wide leave types (administrators). Names and rules are the organisation's own:
 * a hospital, a warehouse and an office can each use what they need. Types in use are switched
 * off rather than deleted, so past requests keep their meaning.
 */
interface LeaveType { id: string; name: string; description: string; requires_reason: boolean; max_days: number | null; is_active: boolean }
const toast = useToast();
const { data, loading, error, reload } = useAsync(() => api.get<LeaveType[]>('/leave-types'));
const editing = ref<(Omit<LeaveType, 'id' | 'max_days'> & { id: string | null; max_days: number | '' }) | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

const openNew = () => {
  errors.value = {};
  editing.value = { id: null, name: '', description: '', requires_reason: false, max_days: '', is_active: true };
};
const openEdit = (t: LeaveType) => {
  errors.value = {};
  editing.value = { ...t, max_days: t.max_days ?? '' };
};
async function save() {
  const e = editing.value!;
  saving.value = true;
  try {
    const body = { name: e.name.trim(), description: e.description.trim(), requires_reason: e.requires_reason, max_days: e.max_days === '' ? null : Number(e.max_days), is_active: e.is_active };
    if (e.id) await api.patch(`/admin/leave-types/${e.id}`, body);
    else await api.post('/admin/leave-types', body);
    toast.ok('Leave type saved');
    editing.value = null;
    await reload(true);
  } catch (err) {
    if (err instanceof ApiError) errors.value = err.fields;
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="leave-types-h">
    <div class="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 id="leave-types-h" class="text-[15px] font-semibold">Leave types</h2>
        <p class="mt-1 text-[13px] text-ink-3">What staff can request. Switch a type off instead of deleting it; past requests keep it.</p>
      </div>
      <UiButton size="sm" @click="openNew">Add leave type</UiButton>
    </div>
    <StateBlock :loading="loading" :error="error" :empty="!data?.length" empty-title="No leave types yet" @retry="reload()">
      <ul class="stagger card divide-y divide-line">
        <li v-for="t in data" :key="t.id">
          <button type="button" class="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left hover:bg-canvas" :class="{ 'text-ink-3': !t.is_active }" @click="openEdit(t)">
            <span class="min-w-0">
              <span class="block text-[14px] font-medium">{{ t.name }}</span>
              <span class="block text-[12.5px] text-ink-3">
                {{ t.requires_reason ? 'Reason required' : 'Reason optional' }}<template v-if="t.max_days"> · up to {{ t.max_days }} days per request</template><template v-if="t.description"> · {{ t.description }}</template>
              </span>
            </span>
            <StatusBadge :tone="t.is_active ? 'ok' : 'neutral'" :label="t.is_active ? 'Available' : 'Switched off'" />
          </button>
        </li>
      </ul>
    </StateBlock>

    <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit leave type' : 'Add leave type'" @close="editing = null">
      <form v-if="editing" id="leave-type-form" class="space-y-4" @submit.prevent="save">
        <UiField v-slot="{ id }" label="Name" :error="errors.name"><input :id="id" v-model="editing.name" class="field-input" maxlength="60" placeholder="e.g. Study leave" /></UiField>
        <UiField v-slot="{ id }" label="Short description" optional><input :id="id" v-model="editing.description" class="field-input" maxlength="300" /></UiField>
        <UiField v-slot="{ id }" label="Most days per request" optional hint="Leave empty for no limit.">
          <input :id="id" v-model="editing.max_days" type="number" min="1" max="365" class="field-input w-32 tnum" />
        </UiField>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="editing.requires_reason" type="checkbox" class="size-4 accent-accent" /> Staff must give a reason</label>
        <label class="flex items-center gap-2 text-[14px]"><input v-model="editing.is_active" type="checkbox" class="size-4 accent-accent" /> Available to request</label>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="leave-type-form" :loading="saving" :disabled="(editing?.name.trim().length ?? 0) < 2">Save</UiButton>
      </template>
    </UiDialog>
  </section>
</template>
