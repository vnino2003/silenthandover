<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import { api } from '@/lib/api';
import { day } from '@/lib/format';
import { peso } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';

/** Released payslips: each line comes from the certified DTR and the hospital's pay rules. */
interface Slip {
  run_id: string;
  start_date: string;
  end_date: string;
  pay_date: string;
  released_at: string;
  net: string;
  lines: { kind: 'earning' | 'deduction'; label: string; quantity: string; rate: string; amount: string }[];
}
const { data, loading, error, reload } = useAsync(() => api.get<Slip[]>('/payslips'));
const d = (iso: string) => day(`${iso}T12:00:00`);
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-3xl space-y-5">
          <PageHeader title="Payslips" description="Released by Finance after your DTR was certified. The demo pay rules are samples and leave out taxes and contributions." />
          <StateBlock :loading="loading" :error="error" :empty="!data?.length" empty-title="No payslips yet" empty-text="A payslip appears here when Finance releases the payroll for a cutoff." @retry="reload()">
            <article v-for="s in data" :key="s.run_id" class="card p-5">
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <h2 class="text-[15px] font-semibold">{{ d(s.start_date) }} – {{ d(s.end_date) }}</h2>
                <span class="text-[13px] text-ink-3">Pay date {{ d(s.pay_date) }}</span>
              </div>
              <table class="mt-3 w-full text-[14px] tnum">
                <tbody class="divide-y divide-line">
                  <tr v-for="(l, i) in s.lines" :key="i">
                    <td class="py-1.5">{{ l.label }}</td>
                    <td class="py-1.5 text-right" :class="l.kind === 'deduction' ? 'text-bad' : ''">{{ l.kind === 'deduction' ? '−' : '' }}{{ peso(l.amount) }}</td>
                  </tr>
                  <tr class="font-semibold"><td class="pt-2">Net pay</td><td class="pt-2 text-right">{{ peso(s.net) }}</td></tr>
                </tbody>
              </table>
            </article>
          </StateBlock>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>
