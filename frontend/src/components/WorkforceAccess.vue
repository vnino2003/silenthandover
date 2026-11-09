<script setup lang="ts">
import { IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref } from 'vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { CAPABILITY_LABEL } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useToast } from '@/stores/toast';

/**
 * Workforce access on User accounts: who has HR, payroll, finance or Nursing Service duties. IT
 * grants and removes them as account administration but never sees their data, and an IT account
 * cannot hold one. Approvals still need a second person (the database enforces it).
 */
const props = defineProps<{ users: { id: string; full_name: string; role: string; is_active?: boolean }[]; departments: { id: string; name: string }[] }>();
interface Grant { id: string; profile_id: string; full_name: string; capability: string; department_id: string | null; department: string | null }
const toast = useToast();
const { data, loading, error, reload } = useAsync(() => api.get<Grant[]>('/admin/access'));
const form = ref({ profile_id: '', capability: 'timekeeper', department_id: '' });
const busy = ref('');
const people = computed(() => props.users.filter((u) => u.role !== 'admin' && u.is_active !== false));
async function grant() {
  busy.value = 'grant';
  try {
    await api.post('/admin/access', { ...form.value, department_id: form.value.department_id || null });
    toast.ok('Access granted');
    form.value.profile_id = '';
    await reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
async function revoke(g: Grant) {
  busy.value = g.id;
  try {
    await api.del(`/admin/access/${g.id}`);
    toast.ok('Access removed');
    await reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <section class="card p-5" aria-labelledby="wf-access-h">
    <h2 id="wf-access-h" class="text-[15px] font-semibold">Workforce access</h2>
    <p class="mt-1 text-[13px] text-ink-3">HR timekeeping, payroll, Finance approval and Nursing Service are duties added to a person's account. You manage who has them; you can't see their data, and IT accounts can't hold them.</p>
    <form class="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end" @submit.prevent="grant">
      <UiField v-slot="{ labelledby }" label="Person">
        <IonSelect v-model="form.profile_id" class="field-input" interface="popover" placeholder="Choose" :aria-labelledby="labelledby">
          <IonSelectOption v-for="u in people" :key="u.id" :value="u.id">{{ u.full_name }}</IonSelectOption>
        </IonSelect>
      </UiField>
      <UiField v-slot="{ labelledby }" label="Duty">
        <IonSelect v-model="form.capability" class="field-input" interface="popover" :aria-labelledby="labelledby">
          <IonSelectOption v-for="(label, key) in CAPABILITY_LABEL" :key="key" :value="key">{{ label }}</IonSelectOption>
        </IonSelect>
      </UiField>
      <UiField v-slot="{ labelledby }" label="Scope">
        <IonSelect v-model="form.department_id" class="field-input" interface="popover" :aria-labelledby="labelledby">
          <IonSelectOption value="">All departments</IonSelectOption>
          <IonSelectOption v-for="d in departments" :key="d.id" :value="d.id">{{ d.name }}</IonSelectOption>
        </IonSelect>
      </UiField>
      <UiButton type="submit" variant="primary" :disabled="!form.profile_id" :loading="busy === 'grant'">Grant</UiButton>
    </form>
    <StateBlock :loading="loading" :error="error" @retry="reload()">
      <ul class="mt-4 divide-y divide-line text-[14px]">
        <li v-for="g in data" :key="g.id" class="flex items-center gap-2 py-2">
          <span class="flex-1"><span class="font-medium">{{ g.full_name }}</span> · {{ CAPABILITY_LABEL[g.capability] ?? g.capability }} · <span class="text-ink-3">{{ g.department ?? 'All departments' }}</span></span>
          <UiButton size="sm" variant="danger" :loading="busy === g.id" @click="revoke(g)">Remove</UiButton>
        </li>
        <li v-if="!data?.length" class="py-2 text-ink-3">Nobody has workforce access yet.</li>
      </ul>
    </StateBlock>
  </section>
</template>
