<script setup lang="ts">
import { IonContent, IonPage, IonSelect, IonSelectOption } from '@ionic/vue';
import { ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { day } from '@/lib/format';
import { DTR_STATE, minutes } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * Certify the unit's DTRs for a cutoff: each one after the staff member confirmed it and nothing is
 * left to settle. The Head Nurse's own DTR is certified by Nursing Service, never by themselves.
 */
interface Person { profile_id: string; full_name: string; id: string; version: number; state: string; totals: Record<string, number>; blocking_items: number; staff_confirmed_at: string | null; certified_at: string | null }
interface Data { periods: { id: string; start_date: string; end_date: string; state: string; pay_group: string }[]; period_id: string | null; people: Person[] }
const auth = useAuth();
const toast = useToast();
const periodId = ref('');
const { data, loading, refreshing, error, reload } = useAsync(() => api.get<Data>(`/manager/dtr${periodId.value ? `?period_id=${periodId.value}` : ''}`), [periodId]);
const busy = ref('');
async function certify(p: Person) {
  busy.value = p.id;
  try {
    await api.post(`/manager/dtr/${p.id}/certify`);
    toast.ok(`${p.full_name}'s DTR certified`);
    await reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
const label = (p: Data['periods'][number]) => `${day(`${p.start_date}T12:00:00`)} – ${day(`${p.end_date}T12:00:00`)} · ${p.pay_group}${p.state === 'locked' ? ' (locked)' : ''}`;
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-5xl space-y-5">
          <PageHeader title="DTR certification" description="Verified as to the prescribed hours: certify each DTR once the staff member confirmed it and its duties are settled. HR then locks the period." />
          <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :empty="!data?.periods.length" empty-title="No cutoff periods yet" empty-text="HR timekeeping opens the cutoff periods." @retry="reload()">
            <label class="block max-w-md text-[13px] font-medium">Cutoff period
              <IonSelect :value="periodId || data?.period_id" class="field-input mt-1" interface="popover" @ion-change="periodId = String($event.detail.value ?? '')">
                <IonSelectOption v-for="p in data?.periods" :key="p.id" :value="p.id">{{ label(p) }}</IonSelectOption>
              </IonSelect>
            </label>
            <div class="table-region card mt-4 overflow-x-auto" tabindex="0" role="region" aria-label="Unit DTRs — scroll horizontally to see all columns">
              <table class="w-full min-w-[720px] text-left text-[14px]">
                <thead class="border-b border-line text-[12.5px] text-ink-3">
                  <tr><th class="px-5 py-2.5 font-medium">Staff</th><th class="px-3 py-2.5 font-medium">Worked</th><th class="px-3 py-2.5 font-medium">Late / under</th><th class="px-3 py-2.5 font-medium">Absences</th><th class="px-3 py-2.5 font-medium">To settle</th><th class="px-3 py-2.5 font-medium">Status</th><th class="px-5 py-2.5" /></tr>
                </thead>
                <tbody class="divide-y divide-line tnum">
                  <tr v-for="p in data?.people" :key="p.profile_id">
                    <td class="px-5 py-3 font-medium">{{ p.full_name }}</td>
                    <td class="px-3 py-3">{{ minutes(p.totals?.worked_minutes) }}</td>
                    <td class="px-3 py-3">{{ minutes((p.totals?.late_minutes ?? 0) + (p.totals?.undertime_minutes ?? 0)) }}</td>
                    <td class="px-3 py-3">{{ p.totals?.absences ?? 0 }}</td>
                    <td class="px-3 py-3" :class="p.blocking_items ? 'text-warn' : 'text-ink-3'">{{ p.blocking_items || '—' }}</td>
                    <td class="px-3 py-3"><StatusBadge :tone="DTR_STATE[p.state]?.tone" :label="DTR_STATE[p.state]?.label ?? p.state" /></td>
                    <td class="px-5 py-3 text-right whitespace-nowrap">
                      <UiButton size="sm" variant="ghost" :to="`/dtr/${p.id}/print`">View</UiButton>
                      <UiButton v-if="p.state === 'staff_confirmed' && p.profile_id !== auth.profile?.id" size="sm" variant="primary" :disabled="p.blocking_items > 0" :loading="busy === p.id" @click="certify(p)">Certify</UiButton>
                    </td>
                  </tr>
                  <tr v-if="!data?.people.length"><td colspan="7" class="px-5 py-6 text-center text-ink-3">No staff of this unit are in the pay group for this period.</td></tr>
                </tbody>
              </table>
            </div>
            <p class="mt-2 text-[12.5px] text-ink-3">“To settle” counts duties not yet verified and open missing punches, possible absences, overtime and pending leave. Settle them on Attendance.</p>
          </StateBlock>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>
