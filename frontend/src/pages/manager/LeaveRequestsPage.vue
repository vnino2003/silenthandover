<script setup lang="ts">
import { IonContent, IonLabel, IonPage, IonSegment, IonSegmentButton, IonTextarea } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime, time } from '@/lib/format';
import { labelDay, labelRange, LEAVE_STATUS, type LeaveStatus } from '@/lib/schedule';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';
import { useAuth } from '@/stores/auth';

/**
 * Leave decisions. Supervisors decide requests from their department (never their own), and see
 * what approval would do to staffing before deciding. Administrators have no part in leave.
 */
interface Row {
  id: string;
  employee_id: string;
  employee_name: string;
  job_title?: string | null;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  status: LeaveStatus;
  decision_note: string;
  decided_at: string | null;
  decided_by_name?: string | null;
  created_at: string;
  can_decide?: boolean;
}
interface Impact {
  shifts: { shift_id: string; label: string; shift_date: string; starts_at: string; ends_at: string; min_staff: number; assigned: number; assigned_after: number; overlap?: 'full' | 'partial' }[];
  others_on_leave: { name: string; start_date: string; end_date: string }[];
}

const toast = useToast();
const auth = useAuth();
const scope = ref<'pending' | 'all'>('pending');
const { data, loading, refreshing, error, reload } = useAsync(
  () => api.get<Row[]>(`/manager/leave?scope=${scope.value}`),
  [scope],
  { refreshMs: 30_000 },
);
const rows = computed(() => data.value ?? []);

// Impact, loaded when a request is opened.
const impacts = ref<Record<string, Impact | 'loading' | 'error'>>({});
async function loadImpact(r: Row) {
  if (impacts.value[r.id]) return;
  impacts.value[r.id] = 'loading';
  try {
    impacts.value[r.id] = await api.get<Impact>(`/manager/leave/${r.id}/impact`);
  } catch {
    impacts.value[r.id] = 'error';
  }
}
const impactOf = (r: Row) => (typeof impacts.value[r.id] === 'object' ? (impacts.value[r.id] as Impact) : null);
/** Shifts approval removes the person from (on the leave days). */
const removed = (i: Impact) => i.shifts.filter((s) => s.overlap !== 'partial');
/** Overnight shifts from the day before that run into the leave: kept, shown for the Head Nurse to handle. */
const partial = (i: Impact) => i.shifts.filter((s) => s.overlap === 'partial');
const shortAfter = (i: Impact) => removed(i).filter((s) => s.min_staff > 0 && s.assigned_after < s.min_staff).length;

// Decide or cancel
const deciding = ref<{ row: Row; decision: 'approved' | 'rejected' | 'cancel'; note: string } | null>(null);
const busy = ref(false);
const noteRequired = computed(() => deciding.value?.decision !== 'approved');
async function confirm() {
  const d = deciding.value;
  if (!d) return;
  busy.value = true;
  try {
    if (d.decision === 'cancel') {
      await api.post(`/manager/leave/${d.row.id}/cancel`, { note: d.note.trim() });
      toast.ok(`Leave cancelled — the ${auth.terms.staffOne} was notified`);
    } else {
      const res = await api.post<{ removed_from_shifts: number; understaffed: unknown[] }>(`/manager/leave/${d.row.id}/decision`, { decision: d.decision, note: d.note.trim() });
      toast.ok(d.decision === 'approved' ? `Leave approved — the ${auth.terms.staffOne} was notified` : `Request declined — the ${auth.terms.staffOne} was notified`);
      if (res.removed_from_shifts) toast.info(`Removed from ${res.removed_from_shifts} shift${res.removed_from_shifts === 1 ? '' : 's'}${res.understaffed.length ? ` · ${res.understaffed.length} now understaffed — check the schedule` : ''}`);
    }
    deciding.value = null;
    await reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-4xl">
            <PageHeader
              title="Leave requests"
              description="Approve or decline leave for your department. You see the effect on staffing before you decide."
            />

            <IonSegment :value="scope" class="sh-segment w-auto" @ion-change="scope = $event.detail.value as typeof scope">
  <IonSegmentButton v-for="t in [{ k: 'pending', l: 'Waiting' }, { k: 'all', l: 'All requests' }] as const" :key="t.k" :value="t.k"><IonLabel>{{ t.l }}</IonLabel></IonSegmentButton>
</IonSegment>

            <StateBlock
              :loading="loading"
              :refreshing="refreshing"
              :error="error"
              :empty="!rows.length"
              :empty-title="scope === 'pending' ? 'No leave waiting for a decision' : 'No leave requests yet'"
              empty-text="New requests appear here and in your notifications."
              @retry="reload()"
            >
              <ul class="stagger space-y-3">
                <li v-for="r in rows" :key="r.id" class="card" @mouseenter="r.status === 'pending' && loadImpact(r)" @focusin="r.status === 'pending' && loadImpact(r)">
                  <div class="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                    <div class="flex min-w-0 items-start gap-3">
                      <UserAvatar :id="r.employee_id" :name="r.employee_name" :size="36" />
                      <div class="min-w-0">
                        <p class="text-[15px] font-semibold">{{ r.employee_name }}<span v-if="r.job_title" class="font-normal text-ink-3"> · {{ r.job_title }}</span></p>
                        <p class="text-[13.5px] text-ink-2 tnum">{{ r.leave_type }} · {{ labelRange(r.start_date, r.end_date) }} · {{ r.days }} day{{ r.days === 1 ? '' : 's' }}</p>
                        <p v-if="r.reason" class="mt-1 text-[13px] text-ink-2">“{{ r.reason }}”</p>
                        <p class="mt-0.5 text-[12px] text-ink-3">Requested {{ dateTime(r.created_at) }}</p>
                        <p v-if="r.decided_by_name && r.decided_at" class="mt-1 text-[12.5px] text-ink-3">
                          {{ LEAVE_STATUS[r.status].label }} by {{ r.decided_by_name }}, {{ dateTime(r.decided_at) }}<template v-if="r.decision_note"> — “{{ r.decision_note }}”</template>
                        </p>
                      </div>
                    </div>
                    <StatusBadge :tone="LEAVE_STATUS[r.status].tone" :label="LEAVE_STATUS[r.status].label" />
                  </div>

                  <!-- What approval would do -->
                  <div v-if="r.status === 'pending'" class="border-t border-line bg-canvas/50 px-5 py-3 text-[13px]">
                    <template v-if="impactOf(r)">
                      <p v-if="!impactOf(r)!.shifts.length" class="text-ink-2">Not on any shift on these days — approving leaves the schedule unchanged.</p>
                      <template v-else>
                        <p class="font-medium" :class="shortAfter(impactOf(r)!) ? 'text-warn' : 'text-ink-2'">
                          Approving removes {{ r.employee_name.split(' ')[0] }} from {{ removed(impactOf(r)!).length }} shift{{ removed(impactOf(r)!).length === 1 ? '' : 's' }}<template v-if="shortAfter(impactOf(r)!)">; {{ shortAfter(impactOf(r)!) }} would be understaffed</template>.
                        </p>
                        <ul class="mt-1.5 space-y-0.5 text-ink-2 tnum">
                          <li v-for="s in removed(impactOf(r)!)" :key="s.shift_id" class="flex flex-wrap gap-x-2">
                            <span>{{ s.label }}, {{ labelDay(s.shift_date) }} · {{ time(s.starts_at) }}</span>
                            <span :class="s.min_staff > 0 && s.assigned_after < s.min_staff ? 'font-medium text-bad' : 'text-ink-3'">{{ s.assigned_after }} of {{ s.min_staff }} staff left</span>
                          </li>
                        </ul>
                        <p v-if="partial(impactOf(r)!).length" class="mt-1.5 text-warn">
                          Runs into the leave, not removed:
                          {{ partial(impactOf(r)!).map((s) => `${s.label}, ${labelDay(s.shift_date)} · ${time(s.starts_at)}–${time(s.ends_at)}`).join('; ') }}.
                          Change it on the duty schedule if needed.
                        </p>
                      </template>
                      <p v-if="impactOf(r)!.others_on_leave.length" class="mt-1.5 text-ink-3">
                        Also on leave: {{ impactOf(r)!.others_on_leave.map((o) => `${o.name} (${labelRange(o.start_date, o.end_date)})`).join(', ') }}
                      </p>
                    </template>
                    <p v-else-if="impacts[r.id] === 'error'" class="text-bad">Couldn’t check the staffing impact.</p>
                    <UiButton v-else size="sm" variant="ghost" :loading="impacts[r.id] === 'loading'" @click="loadImpact(r)">{{ impacts[r.id] === 'loading' ? 'Checking staffing…' : 'Check staffing impact' }}</UiButton>
                  </div>

                  <div v-if="(r.status === 'pending' && r.can_decide) || r.status === 'approved'" class="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
                    <template v-if="r.status === 'pending'">
                      <UiButton size="sm" variant="ghost" @click="deciding = { row: r, decision: 'rejected', note: '' }">Decline</UiButton>
                      <UiButton size="sm" variant="primary" @click="(deciding = { row: r, decision: 'approved', note: '' }), loadImpact(r)">Approve</UiButton>
                    </template>
                    <UiButton v-else size="sm" variant="ghost" @click="deciding = { row: r, decision: 'cancel', note: '' }">Cancel leave</UiButton>
                  </div>
                  <p v-else-if="r.status === 'pending' && !r.can_decide" class="border-t border-line px-5 py-3 text-[12.5px] text-ink-3">This is your own request — another {{ $terms.head }} in your unit decides it.</p>
                </li>
              </ul>
            </StateBlock>

            <UiDialog
              :open="Boolean(deciding)"
              :title="deciding?.decision === 'approved' ? 'Approve this leave?' : deciding?.decision === 'rejected' ? 'Decline this request?' : 'Cancel approved leave?'"
              :description="deciding ? `${deciding.row.employee_name} · ${deciding.row.leave_type} · ${labelRange(deciding.row.start_date, deciding.row.end_date)}` : ''"
              @close="deciding = null"
            >
              <div v-if="deciding" class="space-y-3">
                <p v-if="deciding.decision === 'approved' && (impactOf(deciding.row) && removed(impactOf(deciding.row)!).length)" class="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  {{ deciding.row.employee_name.split(' ')[0] }} will be removed from {{ removed(impactOf(deciding.row)!).length }} shift{{ removed(impactOf(deciding.row)!).length === 1 ? '' : 's' }} and told.
                  <template v-if="shortAfter(impactOf(deciding.row)!)"> {{ shortAfter(impactOf(deciding.row)!) }} will need cover.</template>
                </p>
                <p v-if="deciding.decision === 'cancel'" class="text-[13px] text-ink-2">They won’t be put back on shifts automatically — add them on the schedule if needed.</p>
                <UiField v-slot="{ id, labelledby }" :label="deciding.decision === 'approved' ? 'Comment' : 'Reason'" :optional="!noteRequired" :hint="noteRequired ? `The ${$terms.staffOne} sees this.` : undefined">
                  <IonTextarea :id="id" :aria-labelledby="labelledby" v-model="deciding.note" class="field-input" :rows="2" :maxlength="1000"  auto-grow />
                </UiField>
              </div>
              <template #footer>
                <UiButton variant="ghost" @click="deciding = null">Back</UiButton>
                <UiButton
                  :variant="deciding?.decision === 'approved' ? 'primary' : 'danger'"
                  :loading="busy"
                  :disabled="noteRequired && (deciding?.note.trim().length ?? 0) < 3"
                  @click="confirm"
                >{{ deciding?.decision === 'approved' ? 'Approve' : deciding?.decision === 'rejected' ? 'Decline' : 'Cancel leave' }}</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
