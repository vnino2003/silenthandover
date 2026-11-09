<script setup lang="ts">
import { IonCheckbox, IonContent, IonInput, IonPage, IonSegment, IonSegmentButton, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { computed, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { day, dateTime, relative, time } from '@/lib/format';
import { toggleIn } from '@/lib/toggleIn';
import { EXCEPTION_LABEL, minutes, recordStatus, SOURCE_LABEL, type AttendanceException, type AttendanceRecord } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * The unit's attendance against its duty schedule: scheduled, clocked in, verified present and
 * confirmed absent, with every action the Head Nurse takes on it. Nothing here applies to the
 * Head Nurse's own attendance; the database refuses that too.
 */
interface Board {
  department_id: string;
  today: string;
  from: string;
  to: string;
  records: AttendanceRecord[];
  exceptions: AttendanceException[];
  corrections: { id: string; kind: string; proposed_at: string | null; reason: string; requested_at: string; full_name: string; shift_label: string | null; shift_date: string | null }[];
  stations: { id: string; name: string; kind: string; is_active: boolean; last_seen_at: string | null }[];
  staff: { id: string; full_name: string; job_title: string | null }[];
  coverage: { id: string; reason: string; emergency: boolean; retrospective: boolean; authorized_at: string; shift_label: string; shift_date: string; original_name: string; replacement_name: string }[];
}
const auth = useAuth();
const toast = useToast();
const tz = computed(() => auth.profile?.department_timezone ?? undefined);
const date = ref('');
const tab = ref<'board' | 'items' | 'stations'>('board');
const { data, loading, refreshing, error, reload } = useAsync(
  () => api.get<Board>(`/manager/attendance${date.value ? `?from=${date.value}&to=${date.value}` : ''}`),
  [date],
  { refreshMs: 60_000 },
);
const byShift = computed(() => {
  const groups = new Map<string, AttendanceRecord[]>();
  for (const r of data.value?.records ?? []) {
    const k = `${r.shift_label} · ${time(r.scheduled_start, tz.value)}–${time(r.scheduled_end, tz.value)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()];
});
const counts = computed(() => {
  const r = (data.value?.records ?? []).filter((x) => x.status !== 'excused');
  return {
    scheduled: r.length,
    clocked: r.filter((x) => ['clocked_in', 'present', 'incomplete'].includes(x.status)).length,
    verified: r.filter((x) => x.verified_at).length,
    absent: r.filter((x) => ['no_show', 'absent'].includes(x.status)).length,
  };
});
const isMe = (r: { profile_id?: string }) => r.profile_id === auth.profile?.id;
const punchLine = (r: AttendanceRecord) => r.punches.map((p) => `${p.kind === 'in' ? 'In' : 'Out'} ${time(p.at, tz.value)} · ${SOURCE_LABEL[p.source] ?? p.source}`).join(' · ');
/** Staff who can cover the person in the open Cover dialog. */
const coverOptions = computed(() => { const d = dialog.value; return d?.kind === 'replace' ? (data.value?.staff ?? []).filter((x) => x.id !== d.r.profile_id) : []; });

// ---- Actions ----
const selected = ref<string[]>([]);
const busy = ref('');
async function run(key: string, fn: () => Promise<unknown>, done: string) {
  busy.value = key;
  try {
    await fn();
    toast.ok(done);
    await reload(true);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  } finally {
    busy.value = '';
  }
}
const verifiable = computed(() => (data.value?.records ?? []).filter((r) => r.status === 'present' && !r.verified_at && !r.locked_at && !isMe(r)));
const verify = (ids: string[]) => run('verify', () => api.post('/manager/attendance/verify', { record_ids: ids }), ids.length === 1 ? 'Verified' : `${ids.length} duties verified`).then(() => (selected.value = []));

type Dialog =
  | { kind: 'attest'; r: AttendanceRecord; punch: 'in' | 'out'; at: string; reason: string }
  | { kind: 'absent'; r: AttendanceRecord; note: string }
  | { kind: 'overtime'; r: AttendanceRecord; minutes: number; treatment: 'pay' | 'compensatory_time'; note: string }
  | { kind: 'replace'; r: AttendanceRecord; replacement: string; reason: string; emergency: boolean }
  | { kind: 'resolve'; x: AttendanceException; note: string }
  | { kind: 'reject'; id: string; name: string; note: string }
  | { kind: 'station' }
  | { kind: 'key'; name: string; link: string };
const dialog = ref<Dialog | null>(null);
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const stationName = ref('');
function setMinutes(v: string | number | null | undefined) { if (dialog.value?.kind === 'overtime') dialog.value.minutes = Number(v ?? 0); }
async function save() {
  const d = dialog.value;
  if (!d) return;
  let ok = false;
  if (d.kind === 'attest') ok = await run('dialog', () => api.post('/manager/attendance/attest', { shift_id: d.r.shift_id, profile_id: d.r.profile_id, kind: d.punch, at: new Date(d.at).toISOString(), reason: d.reason }), `Time-${d.punch} attested`);
  if (d.kind === 'absent') ok = await run('dialog', () => api.post(`/manager/attendance/records/${d.r.id}/absent`, { note: d.note }), 'Absence recorded');
  if (d.kind === 'overtime') ok = await run('dialog', () => api.post(`/manager/attendance/records/${d.r.id}/overtime`, { minutes: Number(d.minutes), treatment: Number(d.minutes) > 0 ? d.treatment : null, note: d.note }), 'Overtime decided');
  if (d.kind === 'replace') ok = await run('dialog', () => api.post('/manager/attendance/replace', { shift_id: d.r.shift_id, original_id: d.r.profile_id, replacement_id: d.replacement, reason: d.reason, emergency: d.emergency }), 'Cover recorded');
  if (d.kind === 'resolve') ok = await run('dialog', () => api.post(`/manager/attendance/exceptions/${d.x.id}/resolve`, { note: d.note }), 'Item closed');
  if (d.kind === 'reject') ok = await run('dialog', () => api.post(`/manager/attendance/corrections/${d.id}/decision`, { decision: 'rejected', note: d.note }), 'Correction not approved');
  if (d.kind === 'station') {
    busy.value = 'dialog';
    try {
      const res = await api.post<{ id: string; key: string }>('/manager/attendance/stations', { name: stationName.value });
      dialog.value = { kind: 'key', name: stationName.value, link: `${window.location.origin}/station/${res.id}#key=${res.key}` };
      stationName.value = '';
      await reload(true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      busy.value = '';
    }
    return;
  }
  if (ok) dialog.value = null;
}
const approve = (id: string) => run(`corr-${id}`, () => api.post(`/manager/attendance/corrections/${id}/decision`, { decision: 'approved' }), 'Correction approved');
async function resetStation(s: Board['stations'][number]) {
  busy.value = `st-${s.id}`;
  try {
    const res = await api.post<{ id: string; key: string }>(`/manager/attendance/stations/${s.id}/reset`);
    dialog.value = { kind: 'key', name: s.name, link: `${window.location.origin}/station/${res.id}#key=${res.key}` };
    await reload(true);
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = '';
  }
}
const disableStation = (id: string) => run(`st-${id}`, () => api.post(`/manager/attendance/stations/${id}/disable`), 'Station turned off');
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.ok('Link copied');
  } catch {
    toast.error('Copy the link by hand');
  }
}
const CORR: Record<string, string> = { add_in: 'Add time-in', add_out: 'Add time-out', void_punch: 'Remove a wrong punch' };
const RESOLVABLE = ['late', 'undertime', 'duplicate', 'unscheduled', 'pending_leave'];
const dialogTitle = computed(() => {
  const d = dialog.value;
  if (!d) return '';
  return { attest: `Attest time-${d.kind === 'attest' ? d.punch : ''}`, absent: 'Confirm absence', overtime: 'Decide overtime', replace: 'Arrange cover', resolve: 'Close this item', reject: 'Do not approve the correction', station: 'Add an attendance station', key: 'Station setup link' }[d.kind];
});
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-5xl space-y-5">
          <PageHeader title="Attendance" description="The duty schedule against time-ins and time-outs. Verify complete duties; settle missing punches, overtime and absences.">
            <label class="flex items-center gap-2 text-[13px]"><span class="text-ink-3">Day</span>
              <IonInput v-model="date" type="date" class="field-input w-40" aria-label="Day" />
            </label>
          </PageHeader>

          <IonSegment :value="tab" class="sh-segment" @ion-change="tab = ($event.detail.value as typeof tab)">
            <IonSegmentButton value="board">Duties</IonSegmentButton>
            <IonSegmentButton value="items">To settle <template v-if="(data?.exceptions.length ?? 0) + (data?.corrections.length ?? 0)">({{ (data?.exceptions.length ?? 0) + (data?.corrections.length ?? 0) }})</template></IonSegmentButton>
            <IonSegmentButton value="stations">Stations</IonSegmentButton>
          </IonSegment>

          <StateBlock :loading="loading" :refreshing="refreshing" :error="error" @retry="reload()">
            <template v-if="data && tab === 'board'">
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="card px-4 py-3"><p class="text-[12px] text-ink-3">Scheduled</p><p class="text-[22px] font-semibold tnum">{{ counts.scheduled }}</p></div>
                <div class="card px-4 py-3"><p class="text-[12px] text-ink-3">Clocked in</p><p class="text-[22px] font-semibold tnum">{{ counts.clocked }}</p></div>
                <div class="card px-4 py-3"><p class="text-[12px] text-ink-3">Verified present</p><p class="text-[22px] font-semibold tnum">{{ counts.verified }}</p></div>
                <div class="card px-4 py-3"><p class="text-[12px] text-ink-3">No time-in / absent</p><p class="text-[22px] font-semibold tnum" :class="counts.absent ? 'text-bad' : ''">{{ counts.absent }}</p></div>
              </div>
              <div v-if="verifiable.length" class="mt-4 flex flex-wrap items-center gap-2">
                <UiButton size="sm" variant="primary" :disabled="!selected.length" :loading="busy === 'verify'" @click="verify(selected)">Verify selected ({{ selected.length }})</UiButton>
                <UiButton size="sm" variant="ghost" @click="selected = verifiable.map((r) => r.id)">Select all complete</UiButton>
              </div>
              <p v-if="!byShift.length" class="card mt-4 p-5 text-[14px] text-ink-3">No duties on this day.</p>
              <section v-for="[label, rows] in byShift" :key="label" class="card mt-4">
                <h2 class="border-b border-line px-5 py-3 text-[14px] font-semibold">{{ label }}</h2>
                <ul class="divide-y divide-line">
                  <li v-for="r in rows" :key="r.id" class="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start">
                    <IonCheckbox v-if="r.status === 'present' && !r.verified_at && !r.locked_at && !isMe(r)" :checked="selected.includes(r.id)" :aria-label="`Select ${r.full_name}`" class="mt-1"
                      @ion-change="selected = toggleIn(selected, r.id, $event.detail.checked)" />
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-medium">{{ r.full_name }}</span>
                        <StatusBadge :tone="recordStatus(r).tone" :label="recordStatus(r).label" />
                        <span v-if="r.locked_at" class="text-[12px] text-ink-3">locked</span>
                      </div>
                      <p class="mt-0.5 text-[13px] text-ink-2 tnum">
                        In {{ r.time_in ? time(r.time_in, tz) : '—' }} · Out {{ r.time_out ? time(r.time_out, tz) : '—' }}
                        <template v-if="r.late_minutes"> · late {{ minutes(r.late_minutes) }}</template>
                        <template v-if="r.undertime_minutes"> · left {{ minutes(r.undertime_minutes) }} early</template>
                        <template v-if="r.overtime_candidate_minutes"> · {{ minutes(r.overtime_candidate_minutes) }} outside the shift<template v-if="r.overtime_approved_minutes"> ({{ minutes(r.overtime_approved_minutes) }} approved)</template></template>
                      </p>
                      <p v-if="r.punches.length" class="text-[12px] text-ink-3">{{ punchLine(r) }}</p>
                    </div>
                    <div v-if="!r.locked_at && !isMe(r) && r.status !== 'excused'" class="flex flex-wrap gap-1.5">
                      <UiButton v-if="r.status === 'present' && !r.verified_at" size="sm" variant="secondary" :loading="busy === 'verify'" @click="verify([r.id])">Verify</UiButton>
                      <UiButton v-if="!r.time_in" size="sm" variant="ghost" @click="dialog = { kind: 'attest', r, punch: 'in', at: localInput(r.scheduled_start), reason: '' }">Attest in</UiButton>
                      <UiButton v-if="r.time_in && !r.time_out" size="sm" variant="ghost" @click="dialog = { kind: 'attest', r, punch: 'out', at: localInput(r.scheduled_end), reason: '' }">Attest out</UiButton>
                      <UiButton v-if="r.overtime_candidate_minutes && !r.overtime_approved_minutes" size="sm" variant="ghost" @click="dialog = { kind: 'overtime', r, minutes: r.overtime_candidate_minutes, treatment: 'pay', note: '' }">Overtime</UiButton>
                      <UiButton v-if="r.status === 'no_show'" size="sm" variant="danger" @click="dialog = { kind: 'absent', r, note: '' }">Absent</UiButton>
                      <UiButton v-if="['scheduled', 'no_show', 'clocked_in'].includes(r.status) && !r.time_in" size="sm" variant="ghost" @click="dialog = { kind: 'replace', r, replacement: '', reason: '', emergency: false }">Cover</UiButton>
                    </div>
                  </li>
                </ul>
              </section>
              <section v-if="data.coverage.length" class="card mt-4 p-5">
                <h2 class="text-[14px] font-semibold">Recent cover</h2>
                <ul class="mt-2 space-y-1 text-[13px] text-ink-2">
                  <li v-for="c in data.coverage" :key="c.id">{{ c.replacement_name }} covered {{ c.original_name }} · {{ c.shift_label }}, {{ day(`${c.shift_date}T12:00:00`) }}<template v-if="c.emergency"> · emergency</template><template v-if="c.retrospective"> · recorded afterwards</template> · {{ c.reason }}</li>
                </ul>
              </section>
            </template>

            <template v-if="data && tab === 'items'">
              <section class="card">
                <h2 class="border-b border-line px-5 py-3 text-[14px] font-semibold">Correction requests</h2>
                <p v-if="!data.corrections.length" class="px-5 py-4 text-[14px] text-ink-3">None waiting.</p>
                <ul class="divide-y divide-line">
                  <li v-for="k in data.corrections" :key="k.id" class="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1 text-[14px]">
                      <p><span class="font-medium">{{ k.full_name }}</span> · {{ CORR[k.kind] }}<template v-if="k.proposed_at"> at {{ dateTime(k.proposed_at, tz) }}</template></p>
                      <p class="text-[13px] text-ink-3">{{ k.shift_label ? `${k.shift_label}, ${day(`${k.shift_date}T12:00:00`)} · ` : '' }}{{ k.reason }}</p>
                    </div>
                    <div class="flex gap-1.5">
                      <UiButton size="sm" variant="primary" :loading="busy === `corr-${k.id}`" @click="approve(k.id)">Approve</UiButton>
                      <UiButton size="sm" variant="ghost" @click="dialog = { kind: 'reject', id: k.id, name: k.full_name, note: '' }">Decline</UiButton>
                    </div>
                  </li>
                </ul>
              </section>
              <section class="card mt-4">
                <h2 class="border-b border-line px-5 py-3 text-[14px] font-semibold">Open attendance items</h2>
                <p v-if="!data.exceptions.length" class="px-5 py-4 text-[14px] text-ink-3">Nothing open.</p>
                <ul class="divide-y divide-line">
                  <li v-for="x in data.exceptions" :key="x.id" class="flex flex-col gap-1 px-5 py-3 text-[14px] sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1">
                      <p><span class="font-medium">{{ x.full_name }}</span> · <span class="text-warn">{{ EXCEPTION_LABEL[x.kind] ?? x.kind }}</span></p>
                      <p class="text-[13px] text-ink-3">{{ x.shift_label ? `${x.shift_label}, ${day(`${x.shift_date}T12:00:00`)} · ` : '' }}{{ x.detail }} · {{ relative(x.created_at) }}</p>
                    </div>
                    <UiButton v-if="RESOLVABLE.includes(x.kind) && x.profile_id !== auth.profile?.id" size="sm" variant="ghost" @click="dialog = { kind: 'resolve', x, note: '' }">Close</UiButton>
                    <span v-else class="text-[12px] text-ink-3">Settle it on the Duties tab</span>
                  </li>
                </ul>
              </section>
            </template>

            <template v-if="data && tab === 'stations'">
              <section class="card p-5">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="flex-1 text-[14px] font-semibold">QR attendance stations</h2>
                  <UiButton size="sm" variant="primary" @click="dialog = { kind: 'station' }">Add station</UiButton>
                </div>
                <p class="mt-1 text-[13px] text-ink-3">A tablet at a staff-only spot opens the station link and shows a code that changes every 30 seconds. Staff scan it in their own account.</p>
                <ul class="mt-3 divide-y divide-line">
                  <li v-for="s in data.stations" :key="s.id" class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                    <div class="min-w-0 flex-1 text-[14px]">
                      <p class="font-medium">{{ s.name }} <StatusBadge :tone="s.is_active ? 'ok' : 'neutral'" :label="s.is_active ? 'On' : 'Off'" /></p>
                      <p class="text-[12.5px] text-ink-3">{{ s.kind === 'device' ? 'Terminal' : 'QR station' }} · {{ s.last_seen_at ? `last seen ${relative(s.last_seen_at)}` : 'not opened yet' }}</p>
                    </div>
                    <div class="flex gap-1.5">
                      <UiButton size="sm" variant="ghost" :loading="busy === `st-${s.id}`" @click="resetStation(s)">New setup link</UiButton>
                      <UiButton v-if="s.is_active" size="sm" variant="danger" @click="disableStation(s.id)">Turn off</UiButton>
                    </div>
                  </li>
                </ul>
              </section>
            </template>
          </StateBlock>
        </div>

        <UiDialog :open="Boolean(dialog)" :title="dialogTitle" @close="dialog = null">
          <form v-if="dialog" id="att-form" class="space-y-4" @submit.prevent="save">
            <template v-if="dialog.kind === 'attest'">
              <p class="text-[14px] text-ink-2">{{ dialog.r.full_name }} · {{ dialog.r.shift_label }}, {{ day(dialog.r.scheduled_start, tz) }}. An attested time is shown as attested, not as a scan.</p>
              <UiField v-slot="{ id, labelledby }" label="Time"><IonInput :id="id" v-model="dialog.at" :aria-labelledby="labelledby" class="field-input" type="datetime-local" /></UiField>
              <UiField v-slot="{ id, labelledby }" label="Reason" hint="For example: station down, gloved during a procedure."><IonTextarea :id="id" v-model="dialog.reason" :aria-labelledby="labelledby" class="field-input" :rows="2" :maxlength="500" auto-grow /></UiField>
            </template>
            <template v-if="dialog.kind === 'absent'">
              <p class="text-[14px] text-ink-2">{{ dialog.r.full_name }} has no time-in for {{ dialog.r.shift_label }}, {{ day(dialog.r.scheduled_start, tz) }}. They are told and can request a correction.</p>
              <UiField v-slot="{ id, labelledby }" label="Note" optional><IonInput :id="id" v-model="dialog.note" :aria-labelledby="labelledby" class="field-input" :maxlength="300" /></UiField>
            </template>
            <template v-if="dialog.kind === 'overtime'">
              <p class="text-[14px] text-ink-2">{{ dialog.r.full_name }} recorded {{ minutes(dialog.r.overtime_candidate_minutes) }} outside the scheduled shift.</p>
              <UiField v-slot="{ id, labelledby }" label="Minutes approved" :hint="`0 to ${dialog.r.overtime_candidate_minutes}`"><IonInput :id="id" :value="dialog.minutes" :aria-labelledby="labelledby" class="field-input" type="number" :min="0" :max="dialog.r.overtime_candidate_minutes" @ion-input="setMinutes($event.detail.value)" /></UiField>
              <UiField v-slot="{ labelledby }" label="Treatment">
                <IonSelect v-model="dialog.treatment" class="field-input" interface="popover" :aria-labelledby="labelledby">
                  <IonSelectOption value="pay">Overtime pay</IonSelectOption>
                  <IonSelectOption value="compensatory_time">Compensatory time-off</IonSelectOption>
                </IonSelect>
              </UiField>
              <UiField v-slot="{ id, labelledby }" label="Note" optional><IonInput :id="id" v-model="dialog.note" :aria-labelledby="labelledby" class="field-input" :maxlength="300" /></UiField>
            </template>
            <template v-if="dialog.kind === 'replace'">
              <p class="text-[14px] text-ink-2">{{ dialog.r.full_name }} is taken off {{ dialog.r.shift_label }}, {{ day(dialog.r.scheduled_start, tz) }}; the original assignment stays in the history.</p>
              <UiField v-slot="{ labelledby }" label="Covered by">
                <IonSelect v-model="dialog.replacement" class="field-input" interface="popover" placeholder="Choose" :aria-labelledby="labelledby">
                  <IonSelectOption v-for="s in coverOptions" :key="s.id" :value="s.id">{{ s.full_name }}{{ s.job_title ? ` · ${s.job_title}` : '' }}</IonSelectOption>
                </IonSelect>
              </UiField>
              <UiField v-slot="{ id, labelledby }" label="Reason"><IonTextarea :id="id" v-model="dialog.reason" :aria-labelledby="labelledby" class="field-input" :rows="2" :maxlength="500" auto-grow /></UiField>
              <IonCheckbox :checked="dialog.emergency" label-placement="end" justify="start" class="text-[14px]" @ion-change="dialog.kind === 'replace' && (dialog.emergency = $event.detail.checked)">Emergency cover</IonCheckbox>
            </template>
            <template v-if="dialog.kind === 'resolve'">
              <p class="text-[14px] text-ink-2">{{ dialog.x.full_name }} · {{ EXCEPTION_LABEL[dialog.x.kind] }} · {{ dialog.x.detail }}</p>
              <UiField v-slot="{ id, labelledby }" label="Note"><IonInput :id="id" v-model="dialog.note" :aria-labelledby="labelledby" class="field-input" :maxlength="300" /></UiField>
            </template>
            <template v-if="dialog.kind === 'reject'">
              <p class="text-[14px] text-ink-2">{{ dialog.name }} is told your reason.</p>
              <UiField v-slot="{ id, labelledby }" label="Reason"><IonInput :id="id" v-model="dialog.note" :aria-labelledby="labelledby" class="field-input" :maxlength="300" /></UiField>
            </template>
            <template v-if="dialog.kind === 'station'">
              <UiField v-slot="{ id, labelledby }" label="Station name" hint="For example: Nursery station, near the preparation room."><IonInput :id="id" v-model="stationName" :aria-labelledby="labelledby" class="field-input" :maxlength="80" /></UiField>
            </template>
            <template v-if="dialog.kind === 'key'">
              <p class="text-[14px] text-ink-2">Open this link once on the station tablet for <strong>{{ dialog.name }}</strong>. It is shown only now; making a new link turns the old one off.</p>
              <IonInput :value="dialog.link" readonly class="field-input text-[12px]" aria-label="Station setup link" />
            </template>
          </form>
          <template #footer>
            <template v-if="dialog?.kind === 'key'">
              <UiButton variant="ghost" @click="copy(dialog.link)">Copy link</UiButton>
              <UiButton variant="primary" @click="dialog = null">Done</UiButton>
            </template>
            <template v-else>
              <UiButton variant="ghost" @click="dialog = null">Cancel</UiButton>
              <UiButton variant="primary" type="submit" form="att-form" :loading="busy === 'dialog'">Save</UiButton>
            </template>
          </template>
        </UiDialog>
      </div>
    </IonContent>
  </IonPage>
</template>
