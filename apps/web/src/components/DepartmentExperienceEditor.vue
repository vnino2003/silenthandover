<script setup lang="ts">
import { ref } from 'vue';
import { DepartmentExperience, PROBLEM_CATEGORIES, PROBLEM_CATEGORY_LABELS, RECORD_TYPES, RECORD_TYPE_LABELS } from '@sh/shared';
import UiButton from './ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
const props = defineProps<{ departmentId: string; initial: unknown }>();
const emit = defineEmits<{ saved: [] }>();
const value = ref(DepartmentExperience.parse(props.initial ?? {}));
const busy = ref(false);
const error = ref('');
const fields = [
  { key: 'organization_name', label: 'Organization name' }, { key: 'industry', label: 'Industry / operating context' },
  { key: 'staff_label', label: 'Employee role label' }, { key: 'supervisor_label', label: 'Reviewer role label' },
  { key: 'report_label', label: 'Report label' }, { key: 'issue_label', label: 'Issue label' },
] as const;
const guidance = [
  { key: 'completed_hint', label: 'Completed work guidance' }, { key: 'unresolved_hint', label: 'Open concerns guidance' },
  { key: 'pending_hint', label: 'Next-team guidance' }, { key: 'concerns_hint', label: 'Operational concerns guidance' },
  { key: 'privacy_hint', label: 'Privacy guidance' },
] as const;
async function save() {
  busy.value = true; error.value = '';
  try { await api.put(`/admin/departments/${props.departmentId}/experience`, value.value); emit('saved'); }
  catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <form class="space-y-5" @submit.prevent="save">
    <div class="grid gap-3 sm:grid-cols-2">
      <label v-for="f in fields" :key="f.key" class="block text-[13px] font-medium">{{ f.label }}<input v-model="value[f.key]" class="field-input mt-1" :maxlength="['organization_name', 'industry'].includes(f.key) ? 100 : 40" /></label>
    </div>
    <label v-for="g in guidance" :key="g.key" class="block text-[13px] font-medium">{{ g.label }}<textarea v-model="value[g.key]" class="field-input mt-1" rows="2" maxlength="400" /></label>
    <fieldset><legend class="text-[13px] font-semibold">Available reporting categories</legend><div class="mt-2 grid gap-2 sm:grid-cols-2"><label v-for="c in PROBLEM_CATEGORIES" :key="c" class="flex items-center gap-2 text-[13px]"><input v-model="value.categories" type="checkbox" :value="c" class="size-4 accent-accent" />{{ PROBLEM_CATEGORY_LABELS[c] }}</label></div></fieldset>
    <fieldset><legend class="text-[13px] font-semibold">Available source-record types</legend><div class="mt-2 grid gap-2 sm:grid-cols-2"><label v-for="t in RECORD_TYPES" :key="t" class="flex items-center gap-2 text-[13px]"><input v-model="value.record_types" type="checkbox" :value="t" class="size-4 accent-accent" />{{ RECORD_TYPE_LABELS[t] }}</label></div></fieldset>
    <p class="rounded-md bg-sunken p-3 text-[12px] text-ink-2">Schedules, reporting windows and team assignments are configured by the department’s supervisor. Authorization, review and resolution verification remain enforced.</p>
    <p v-if="error" role="alert" class="text-[13px] text-bad">{{ error }}</p>
    <UiButton type="submit" variant="primary" :loading="busy" :disabled="!value.categories.length || !value.record_types.length">Save department experience</UiButton>
  </form>
</template>
