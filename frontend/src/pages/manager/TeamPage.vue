<script setup lang="ts">
import { IonContent, IonInput, IonPage } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge, { type Tone } from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api } from '@/lib/api';
import { day, time } from '@/lib/format';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';

/**
 * The supervisor's team: everyone active in the department, with today's status, the next shift,
 * this week's shifts and leave. A list only: the administrator creates and changes accounts.
 */
interface Member {
  id: string;
  full_name: string;
  job_title: string | null;
  photo_version: number | null;
  status: 'on_duty' | 'on_leave' | 'rest_day' | 'day_off' | 'scheduled_today' | 'off_today';
  next_shift: { label: string; starts_at: string; ends_at: string } | null;
  shifts_this_week: number;
  upcoming_leave: { leave_type: string; start_date: string; end_date: string }[];
  pending_leave: number;
}
const auth = useAuth();
const { data, loading, error, reload, refreshing } = useAsync(() => api.get<{ today: string; members: Member[] }>('/manager/team'), [], { refreshMs: 60_000 });
const STATUS: Record<Member['status'], { label: string; tone: Tone }> = {
  on_duty: { label: 'On duty now', tone: 'ok' },
  scheduled_today: { label: 'Working today', tone: 'info' },
  on_leave: { label: 'On leave', tone: 'warn' },
  rest_day: { label: 'Rest day', tone: 'neutral' },
  day_off: { label: 'Day off', tone: 'neutral' },
  off_today: { label: 'Not scheduled today', tone: 'neutral' },
};
const query = ref('');
const members = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (data.value?.members ?? []).filter((m) => !q || m.full_name.toLowerCase().includes(q) || (m.job_title ?? '').toLowerCase().includes(q));
});
const onDuty = computed(() => data.value?.members.filter((m) => m.status === 'on_duty').length ?? 0);
const away = computed(() => data.value?.members.filter((m) => m.status === 'on_leave').length ?? 0);
const isoDay = (iso: string) => day(`${iso}T12:00:00`);
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-5xl">
            <PageHeader title="Unit staff" :description="`Everyone in your unit. Accounts are created and changed by the system administrator.`">
              <UiButton to="/manager/schedule" variant="ghost" size="sm">Open duty schedule</UiButton>
            </PageHeader>

            <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :empty="!data?.members.length" :empty-title="`No ${auth.terms.staffPlural.toLowerCase()} yet`" empty-text="The administrator adds people to your department on the Users page." @retry="reload()">
              <div class="stagger mb-5 grid gap-3 sm:grid-cols-3">
                <div class="card px-4 py-3"><p class="text-[12.5px] text-ink-3">{{ auth.terms.staffPlural }}</p><p class="text-[22px] font-semibold tnum">{{ data?.members.length ?? 0 }}</p></div>
                <div class="card px-4 py-3"><p class="text-[12.5px] text-ink-3">On duty now</p><p class="text-[22px] font-semibold tnum">{{ onDuty }}</p></div>
                <div class="card px-4 py-3"><p class="text-[12.5px] text-ink-3">On leave today</p><p class="text-[22px] font-semibold tnum">{{ away }}</p></div>
              </div>

              <label class="mb-3 block max-w-xs"><span class="sr-only">Search unit staff</span><IonInput v-model="query" class="field-input" type="search" placeholder="Search by name or job title"  /></label>

              <ul class="stagger card divide-y divide-line">
                <li v-for="m in members" :key="m.id" class="grid gap-3 px-5 py-3.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                  <div class="flex min-w-0 items-center gap-3">
                    <UserAvatar :id="m.id" :name="m.full_name" :version="m.photo_version" :size="36" />
                    <div class="min-w-0">
                      <p class="truncate text-[14px] font-medium">{{ m.full_name }}</p>
                      <p class="truncate text-[12.5px] text-ink-3">{{ m.job_title ?? auth.terms.staff }}</p>
                    </div>
                  </div>
                  <div class="text-[13px]">
                    <p class="text-[11.5px] text-ink-3">Next shift</p>
                    <p v-if="m.next_shift" class="tnum">{{ m.next_shift.label }} · {{ day(m.next_shift.starts_at) }}, {{ time(m.next_shift.starts_at) }}</p>
                    <p v-else class="text-ink-3">None in the next 7 days</p>
                  </div>
                  <div class="text-[13px]">
                    <p class="text-[11.5px] text-ink-3">This week</p>
                    <p class="tnum">{{ m.shifts_this_week }} shift{{ m.shifts_this_week === 1 ? '' : 's' }}<template v-if="m.upcoming_leave.length"> · leave {{ isoDay(m.upcoming_leave[0]!.start_date) }}</template></p>
                    <RouterLink v-if="m.pending_leave" to="/manager/leave" class="link text-[12.5px]">{{ m.pending_leave }} leave request{{ m.pending_leave === 1 ? '' : 's' }} waiting</RouterLink>
                  </div>
                  <StatusBadge :tone="STATUS[m.status].tone" :label="STATUS[m.status].label" class="justify-self-start sm:justify-self-end" />
                </li>
              </ul>
              <p v-if="!members.length && query" class="mt-3 text-[13px] text-ink-3">Nobody matches “{{ query }}”.</p>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
