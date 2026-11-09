<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSelect, IonSelectOption } from '@ionic/vue';
import { ref } from 'vue';
import DepartmentExperienceEditor from '@/components/DepartmentExperienceEditor.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { tzLabel } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import type { Department } from '@/lib/useAdminRefs';
import { useToast } from '@/stores/toast';

const toast = useToast();
const customizing = ref<Department | null>(null);
const { data, loading, error, reload } = useAsync(() => api.get<Department[]>('/admin/departments'));
const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Manila', 'UTC'];
  }
})();

const editing = ref<{ id: string | null; code: string; name: string; timezone: string } | null>(null);
const team = ref<{ department: Department; name: string } | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

async function saveDept() {
  const e = editing.value!;
  saving.value = true;
  errors.value = {};
  try {
    const body = { code: e.code, name: e.name, timezone: e.timezone };
    if (e.id) await api.patch(`/admin/departments/${e.id}`, body);
    else await api.post('/admin/departments', body);
    toast.ok('Department saved');
    editing.value = null;
    await reload(true);
  } catch (err) {
    if (err instanceof ApiError) errors.value = err.fields;
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}
async function saveTeam() {
  const t = team.value!;
  saving.value = true;
  try {
    await api.post(`/admin/departments/${t.department.id}/teams`, { name: t.name });
    toast.ok('Team added');
    team.value = null;
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-4xl">
            <PageHeader title="Departments and units" description="Each department head sees shift endorsements from their own unit only. Shift times use the unit’s time zone.">
              <UiButton variant="primary" @click="(editing = { id: null, code: '', name: '', timezone: 'Asia/Manila' }), (errors = {})">Add department</UiButton>
            </PageHeader>
            <StateBlock :loading="loading" :error="error" :empty="!data?.length" empty-title="No departments yet" @retry="reload()">
              <ul class="space-y-3">
                <li v-for="d in data" :key="d.id" class="card p-5">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p class="text-[15px] font-semibold">{{ d.name }} <span class="ml-1 text-[12.5px] font-normal text-ink-3 tnum">{{ d.code }}</span></p>
                      <p class="text-[13px] text-ink-3">{{ d.timezone }} ({{ tzLabel(d.timezone) }}) · {{ d.member_count }} active member{{ d.member_count === 1 ? '' : 's' }}</p>
                    </div>
                    <div class="flex gap-2">
                      <UiButton size="sm" @click="customizing = d">Customize</UiButton>
                      <UiButton size="sm" variant="ghost" @click="team = { department: d, name: '' }">Add team</UiButton>
                      <UiButton size="sm" @click="(editing = { id: d.id, code: d.code, name: d.name, timezone: d.timezone }), (errors = {})">Edit</UiButton>
                    </div>
                  </div>
                  <div v-if="d.teams.length" class="mt-3 flex flex-wrap gap-1.5">
                    <span v-for="t in d.teams" :key="t.id" class="rounded-full border border-line px-2.5 py-0.5 text-[12.5px] text-ink-2">{{ t.name }}</span>
                  </div>
                </li>
              </ul>
            </StateBlock>
            <UiDialog :open="Boolean(customizing)" :title="`Customize ${customizing?.name ?? 'department'}`" wide @close="customizing = null">
              <DepartmentExperienceEditor v-if="customizing" :key="customizing.id" :department-id="customizing.id" :initial="customizing.experience" @saved="customizing = null; reload(); toast.ok('Department experience saved')" />
            </UiDialog>

            <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit department' : 'Add department'" @close="editing = null">
              <form v-if="editing" id="dept-form" class="space-y-4" @submit.prevent="saveDept">
                <div class="grid grid-cols-[110px_1fr] gap-3">
                  <UiField v-slot="{ id, labelledby }" label="Code" :error="errors.code"><IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.code" class="field-input uppercase" :maxlength="12"  /></UiField>
                  <UiField v-slot="{ id, labelledby }" label="Name" :error="errors.name"><IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.name" class="field-input" :maxlength="120"  /></UiField>
                </div>
                <UiField v-slot="{ id, labelledby }" label="Time zone" :error="errors.timezone">
                  <IonSelect :id="id" :aria-labelledby="labelledby" v-model="editing.timezone" class="field-input" interface="popover">
                    <IonSelectOption v-for="z in zones" :key="z" :value="z">{{ z }}</IonSelectOption>
                  </IonSelect>
                </UiField>
              </form>
              <template #footer>
                <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
                <UiButton variant="primary" type="submit" form="dept-form" :loading="saving">Save</UiButton>
              </template>
            </UiDialog>

            <UiDialog :open="Boolean(team)" :title="`Add a team to ${team?.department.name ?? ''}`" @close="team = null">
              <form v-if="team" id="team-form" @submit.prevent="saveTeam">
                <UiField v-slot="{ id, labelledby }" label="Team name"><IonInput :id="id" :aria-labelledby="labelledby" v-model="team.name" class="field-input" :maxlength="120"  /></UiField>
              </form>
              <template #footer>
                <UiButton variant="ghost" @click="team = null">Cancel</UiButton>
                <UiButton variant="primary" type="submit" form="team-form" :loading="saving" :disabled="(team?.name.trim().length ?? 0) < 2">Add team</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
