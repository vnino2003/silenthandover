<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { Dtr } from '@/components/DtrSheet.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api } from '@/lib/api';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';

/**
 * A printable DTR laid out like Civil Service Form No. 48 (Daily Time Record): one row per day of
 * the cutoff with arrival and departure for the morning and afternoon, undertime, the employee's
 * honor certification and the in-charge's verification. Overnight duty shows its arrival on the
 * day it starts and its departure on the next day.
 */
const route = useRoute();
const auth = useAuth();
const tz = computed(() => auth.profile?.department_timezone ?? 'Asia/Manila');
const { data, loading, error, reload } = useAsync(() => api.get<Dtr>(`/dtr/${route.params.id}`));

const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz.value }).format(new Date(iso));
const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz.value }).format(new Date(iso));
const isAm = (iso: string) => Number(hhmm(iso).slice(0, 2)) < 12;

const rows = computed(() => {
  const d = data.value;
  if (!d) return [];
  const out: { date: string; amIn: string; amOut: string; pmIn: string; pmOut: string; underH: string; underM: string; note: string }[] = [];
  for (let t = Date.parse(`${d.start_date}T00:00:00Z`); t <= Date.parse(`${d.end_date}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = { date, amIn: '', amOut: '', pmIn: '', pmOut: '', underH: '', underM: '', note: '' };
    for (const x of d.days) {
      if (x.time_in && localDay(x.time_in) === date) (isAm(x.time_in) ? (row.amIn = hhmm(x.time_in)) : (row.pmIn = hhmm(x.time_in)));
      if (x.time_out && localDay(x.time_out) === date) (isAm(x.time_out) ? (row.amOut = hhmm(x.time_out)) : (row.pmOut = hhmm(x.time_out)));
      if (x.day === date) {
        const under = x.late_minutes + x.undertime_minutes;
        if (under) { row.underH = String(Math.floor(under / 60) || ''); row.underM = String(under % 60 || ''); }
        if (x.status === 'excused') row.note = x.unpaid_leave_minutes ? 'Leave w/o pay' : 'On leave';
        else if (x.status === 'absent') row.note = 'Absent';
      }
    }
    out.push(row);
  }
  return out;
});
const totalUnder = computed(() => (data.value ? (data.value.totals.late_minutes ?? 0) + (data.value.totals.undertime_minutes ?? 0) : 0));
const printPage = () => window.print();
const dayNo = (iso: string) => Number(iso.slice(8, 10));
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="dtr-print mx-auto max-w-[680px] px-4 py-6">
        <div class="no-print mb-4 flex gap-2">
          <UiButton size="sm" variant="ghost" @click="$router.back()">← Back</UiButton>
          <UiButton size="sm" variant="primary" @click="printPage">Print</UiButton>
        </div>
        <StateBlock :loading="loading" :error="error" @retry="reload()">
          <article v-if="data" class="bg-white p-6 text-[12px] text-black">
            <p class="text-[10px] italic">Civil Service Form No. 48 (format)</p>
            <h1 class="mt-1 text-center text-[15px] font-bold tracking-wide">DAILY TIME RECORD</h1>
            <p class="mt-3 text-center text-[14px] font-semibold underline">{{ data.full_name }}</p>
            <p class="text-center text-[10px]">(Name)</p>
            <p class="mt-2">For the period <strong>{{ data.start_date }} to {{ data.end_date }}</strong></p>
            <p>{{ data.job_title ?? 'Staff' }}<template v-if="data.department"> · {{ data.department }}</template> · Official hours: per duty schedule</p>
            <table class="mt-3 w-full border-collapse text-center tnum">
              <thead>
                <tr>
                  <th rowspan="2" class="border border-black px-1">Day</th>
                  <th colspan="2" class="border border-black px-1">A.M.</th>
                  <th colspan="2" class="border border-black px-1">P.M.</th>
                  <th colspan="2" class="border border-black px-1">Undertime</th>
                </tr>
                <tr>
                  <th class="border border-black px-1">Arrival</th><th class="border border-black px-1">Departure</th>
                  <th class="border border-black px-1">Arrival</th><th class="border border-black px-1">Departure</th>
                  <th class="border border-black px-1">Hours</th><th class="border border-black px-1">Minutes</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.date">
                  <td class="border border-black px-1">{{ dayNo(r.date) }}</td>
                  <template v-if="r.note"><td colspan="4" class="border border-black px-1 italic">{{ r.note }}</td></template>
                  <template v-else>
                    <td class="border border-black px-1">{{ r.amIn }}</td><td class="border border-black px-1">{{ r.amOut }}</td>
                    <td class="border border-black px-1">{{ r.pmIn }}</td><td class="border border-black px-1">{{ r.pmOut }}</td>
                  </template>
                  <td class="border border-black px-1">{{ r.underH }}</td><td class="border border-black px-1">{{ r.underM }}</td>
                </tr>
                <tr>
                  <td colspan="5" class="border border-black px-1 text-right font-semibold">Total</td>
                  <td class="border border-black px-1">{{ Math.floor(totalUnder / 60) || '' }}</td><td class="border border-black px-1">{{ totalUnder % 60 || '' }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-4 text-justify">
              I certify on my honor that the above is a true and correct report of the hours of work performed, record of which was made daily at the time of arrival and departure from office.
            </p>
            <p class="mt-6 text-center">______________________________<br />{{ data.full_name }}<span v-if="data.staff_confirmed_at"> · confirmed in the system {{ data.staff_confirmed_at.slice(0, 10) }}</span></p>
            <p class="mt-4 text-center">Verified as to the prescribed office hours:</p>
            <p class="mt-6 text-center">______________________________<br />{{ data.certified_by_name ?? 'In charge' }}<span v-if="data.certified_at"> · certified in the system {{ data.certified_at.slice(0, 10) }}</span><br /><span class="text-[10px]">In charge</span></p>
            <p class="mt-4 text-[10px] text-gray-600">Silent Handover DTR version {{ data.version }} ({{ data.state.replace('_', ' ') }}). Times are from verified attendance records; corrections are recorded in the system's audit log.</p>
          </article>
        </StateBlock>
      </div>
    </IonContent>
  </IonPage>
</template>

<style>
@media print {
  .no-print, ion-menu, ion-header, ion-footer { display: none !important; }
  .dtr-print { max-width: none; padding: 0; }
}
</style>
