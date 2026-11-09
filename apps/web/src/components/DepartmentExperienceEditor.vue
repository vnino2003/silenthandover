<script setup lang="ts">
import { toggleIn } from '@/lib/toggleIn';
import { IonCheckbox, IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { ref } from 'vue';
import { DepartmentExperience, HOSPITAL_UNIT_TEMPLATES, PROBLEM_CATEGORIES, PROBLEM_CATEGORY_LABELS, RECORD_TYPES, RECORD_TYPE_LABELS } from '@sh/shared';
import UiButton from './ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
const props = defineProps<{ departmentId: string; initial: unknown }>();
const emit = defineEmits<{ saved: [] }>();
const value = ref(DepartmentExperience.parse(props.initial ?? {}));
const busy = ref(false);
const error = ref('');
const template = ref('');
const fields = [
  { key: 'organization_name', label: 'Hospital name' }, { key: 'industry', label: 'Unit type (e.g. Nursery, Emergency Room)' },
  { key: 'staff_label', label: 'What the unit’s staff are called' }, { key: 'supervisor_label', label: 'Department head title (e.g. Head Nurse)' },
  { key: 'report_label', label: 'Name of the end-of-shift report' }, { key: 'issue_label', label: 'Name of a reported concern' },
] as const;
const guidance = [
  { key: 'completed_hint', label: 'Tasks completed: guidance' }, { key: 'unresolved_hint', label: 'Unresolved concerns: guidance' },
  { key: 'pending_hint', label: 'Pending tasks for the incoming shift: guidance' }, { key: 'concerns_hint', label: 'Unit concerns: guidance' },
  { key: 'privacy_hint', label: 'Patient privacy reminder' },
] as const;
/** Fills every field from a hospital unit's ready wording; the hospital name already entered is kept. */
function applyTemplate(name: string) {
  const t = HOSPITAL_UNIT_TEMPLATES.find((x) => x.name === name);
  if (!t) return;
  value.value = DepartmentExperience.parse({ ...t.experience, organization_name: value.value.organization_name || t.experience.organization_name });
}
async function save() {
  busy.value = true; error.value = '';
  try { await api.put(`/admin/departments/${props.departmentId}/experience`, value.value); emit('saved'); }
  catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <form class="space-y-5" @submit.prevent="save">
    <label class="block text-[13px] font-medium">Start from a hospital unit
      <IonSelect v-model="template" class="field-input mt-1" interface="popover" placeholder="Choose a unit to fill in its wording…" @ion-change="applyTemplate(String($event.detail.value ?? ''))">
        <IonSelectOption v-for="t in HOSPITAL_UNIT_TEMPLATES" :key="t.name" :value="t.name">{{ t.name }}</IonSelectOption>
      </IonSelect>
      <span class="mt-1 block text-[12px] font-normal text-ink-3">Fills in the titles, guidance and categories below. You can still change any of them before saving.</span>
    </label>
    <div class="grid gap-3 sm:grid-cols-2">
      <label v-for="f in fields" :key="f.key" class="block text-[13px] font-medium">{{ f.label }}<IonInput v-model="value[f.key]" class="field-input mt-1" :maxlength="['organization_name', 'industry'].includes(f.key) ? 100 : 40"  /></label>
    </div>
    <label v-for="g in guidance" :key="g.key" class="block text-[13px] font-medium">{{ g.label }}<IonTextarea v-model="value[g.key]" class="field-input mt-1" :rows="2" :maxlength="400"  auto-grow /></label>
    <fieldset><legend class="text-[13px] font-semibold">Concern categories staff can choose</legend><div class="mt-2 grid gap-2 sm:grid-cols-2"><IonCheckbox v-for="c in PROBLEM_CATEGORIES" :key="c" :checked="value.categories.includes(c)" label-placement="end" justify="start" class="text-[13px]" @ion-change="value.categories = toggleIn(value.categories, c, $event.detail.checked)">{{ PROBLEM_CATEGORY_LABELS[c] }}</IonCheckbox></div></fieldset>
    <fieldset><legend class="text-[13px] font-semibold">Unit record types</legend><div class="mt-2 grid gap-2 sm:grid-cols-2"><IonCheckbox v-for="t in RECORD_TYPES" :key="t" :checked="value.record_types.includes(t)" label-placement="end" justify="start" class="text-[13px]" @ion-change="value.record_types = toggleIn(value.record_types, t, $event.detail.checked)">{{ RECORD_TYPE_LABELS[t] }}</IonCheckbox></div></fieldset>
    <p class="rounded-md bg-sunken p-3 text-[12px] text-ink-2">Duty schedules, endorsement windows and staff assignments are set by the unit’s department head. Access control, approval and verification of resolved concerns stay enforced.</p>
    <p v-if="error" role="alert" class="text-[13px] text-bad">{{ error }}</p>
    <UiButton type="submit" variant="primary" :loading="busy" :disabled="!value.categories.length || !value.record_types.length">Save unit wording</UiButton>
  </form>
</template>
