<script setup lang="ts">
import { IonContent, IonPage, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref, watch } from 'vue';
import DtrSheet, { type Dtr } from '@/components/DtrSheet.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import { api, errorMessage } from '@/lib/api';
import { day } from '@/lib/format';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/** The staff member's own DTR per cutoff: check it, confirm it, then the Head Nurse certifies it. */
interface Period { id: string; start_date: string; end_date: string; pay_date: string; state: string; pay_group: string }
const auth = useAuth();
const toast = useToast();
const tz = computed(() => auth.profile?.department_timezone ?? undefined);
const periods = useAsync(() => api.get<Period[]>('/dtr/periods'));
const periodId = ref('');
watch(() => periods.data.value, (p) => { if (p?.length && !periodId.value) periodId.value = p[0]!.id; }, { immediate: true });
const dtr = useAsync(() => (periodId.value ? api.get<Dtr>(`/dtr/mine/${periodId.value}`) : Promise.resolve(null)), [periodId]);
const confirming = ref(false);
const busy = ref(false);
async function confirm() {
  if (!dtr.data.value) return;
  busy.value = true;
  try {
    await api.post(`/dtr/${dtr.data.value.id}/confirm`);
    toast.ok('Confirmed. Your department head can now certify it.');
    confirming.value = false;
    await dtr.reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = false;
  }
}
const label = (p: Period) => `${day(`${p.start_date}T12:00:00`)} – ${day(`${p.end_date}T12:00:00`)}${p.state === 'locked' ? ' (locked)' : ''}`;
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-4xl space-y-5">
          <PageHeader title="My DTR" description="Your Daily Time Record for each cutoff, built from your verified attendance. Confirm it is true and correct; your department head certifies it.">
            <UiButton v-if="dtr.data.value" size="sm" variant="ghost" :to="`/dtr/${dtr.data.value.id}/print`">Print (Form 48)</UiButton>
          </PageHeader>
          <StateBlock :loading="periods.loading.value" :error="periods.error.value" :empty="!periods.data.value?.length" empty-title="No cutoff periods yet" empty-text="HR opens a DTR period when you are in a pay group." @retry="periods.reload()">
            <label class="block max-w-xs text-[13px] font-medium">Cutoff period
              <IonSelect v-model="periodId" class="field-input mt-1" interface="popover">
                <IonSelectOption v-for="p in periods.data.value" :key="p.id" :value="p.id">{{ label(p) }}</IonSelectOption>
              </IonSelect>
            </label>
            <StateBlock :loading="dtr.loading.value" :error="dtr.error.value" @retry="dtr.reload()">
              <div v-if="dtr.data.value" class="mt-4 space-y-4">
                <DtrSheet :dtr="dtr.data.value" :tz="tz" />
                <div v-if="dtr.data.value.state === 'draft'" class="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <p class="flex-1 text-[14px] text-ink-2">
                    <template v-if="dtr.data.value.blocking_items">{{ dtr.data.value.blocking_items }} item(s) still need your department head (verification, missing punches, overtime or leave). You can confirm now; it is certified once they are settled.</template>
                    <template v-else>Everything is settled. Confirm it is true and correct.</template>
                  </p>
                  <UiButton variant="primary" @click="confirming = true">Confirm my DTR</UiButton>
                </div>
                <p v-else-if="dtr.data.value.state === 'certified'" class="text-[13px] text-ink-3">Certified by {{ dtr.data.value.certified_by_name }}.</p>
              </div>
            </StateBlock>
          </StateBlock>
        </div>
        <UiDialog :open="confirming" title="Confirm your DTR?" description="I certify on my honor that this is a true and correct report of the hours of work I performed." @close="confirming = false">
          <template #footer>
            <UiButton variant="ghost" @click="confirming = false">Cancel</UiButton>
            <UiButton variant="primary" :loading="busy" @click="confirm">Confirm</UiButton>
          </template>
        </UiDialog>
      </div>
    </IonContent>
  </IonPage>
</template>
