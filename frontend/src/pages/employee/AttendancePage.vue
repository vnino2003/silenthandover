<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';
import { day, time } from '@/lib/format';
import { EXCEPTION_LABEL, minutes, parseStationQr, recordStatus, SOURCE_LABEL, type AttendanceException, type AttendanceRecord } from '@/lib/workforce';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

/**
 * Staff attendance: time in and out at the unit's QR station (camera scan or the 6-digit code it
 * shows), the last two weeks of duties, items to fix, and correction requests.
 */
interface Mine {
  today: string;
  records: AttendanceRecord[];
  exceptions: AttendanceException[];
  corrections: { id: string; kind: string; proposed_at: string | null; reason: string; status: string; decision_note: string; requested_at: string }[];
  stations: { id: string; name: string }[];
}
const auth = useAuth();
const toast = useToast();
const tz = computed(() => auth.profile?.department_timezone ?? undefined);
const { data, loading, error, reload } = useAsync(() => api.get<Mine>('/attendance/me'), [], { refreshMs: 60_000 });

// ---- Time in / out ----
const stationId = ref('');
const code = ref('');
const busy = ref(false);
const scanError = ref('');
async function punch(station: string, value: string) {
  busy.value = true;
  scanError.value = '';
  try {
    const res = await api.post<{ kind: 'in' | 'out'; captured_at: string; repeat: boolean }>('/attendance/scan', { station_id: station, code: value });
    toast.ok(res.repeat ? 'Already recorded a moment ago' : `Time-${res.kind} recorded at ${time(res.captured_at, tz.value)}`);
    code.value = '';
    await reload(true);
  } catch (e) {
    scanError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function submitCode() {
  const station = stationId.value || data.value?.stations[0]?.id;
  if (!station) return (scanError.value = 'Your unit has no attendance station yet. Ask your department head.');
  if (!/^\d{6}$/.test(code.value)) return (scanError.value = 'Enter the 6 digits shown on the station.');
  void punch(station, code.value);
}

// Camera scan where the browser can read QR codes (Chrome on Android, the Android app). The camera is
// asked for only when the person taps Scan, and released when done.
const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
const scanning = ref(false);
const video = ref<HTMLVideoElement | null>(null);
let stream: MediaStream | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
async function startScan() {
  scanError.value = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    scanError.value = 'The camera is not available. Type the 6-digit code instead.';
    return;
  }
  scanning.value = true;
  await new Promise((r) => setTimeout(r, 50));
  if (!video.value) return stopScan();
  video.value.srcObject = stream;
  await video.value.play().catch(() => undefined);
  const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  const detector = new Detector({ formats: ['qr_code'] });
  timer = setInterval(async () => {
    if (!video.value || busy.value) return;
    const found = (await detector.detect(video.value).catch(() => [])).map((x) => parseStationQr(x.rawValue)).find(Boolean);
    if (found) {
      stopScan();
      await punch(found.station_id, found.code);
    }
  }, 400);
}
function stopScan() {
  if (timer) clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  scanning.value = false;
}
onBeforeUnmount(stopScan);

// ---- Corrections ----
const correcting = ref<{ shift_id: string | null; kind: 'add_in' | 'add_out' | 'void_punch'; at: string; reason: string; label: string } | null>(null);
const saving = ref(false);
const correctionError = ref('');
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function openCorrection(r: AttendanceRecord, kind: 'add_in' | 'add_out') {
  correctionError.value = '';
  correcting.value = { shift_id: r.shift_id, kind, at: localInput(kind === 'add_in' ? r.scheduled_start : r.scheduled_end), reason: '', label: `${r.shift_label}, ${day(r.scheduled_start, tz.value)}` };
}
async function sendCorrection() {
  if (!correcting.value) return;
  saving.value = true;
  correctionError.value = '';
  try {
    await api.post('/attendance/corrections', {
      shift_id: correcting.value.shift_id,
      kind: correcting.value.kind,
      at: new Date(correcting.value.at).toISOString(),
      reason: correcting.value.reason,
    });
    toast.ok('Correction sent to your department head');
    correcting.value = null;
    await reload(true);
  } catch (e) {
    correctionError.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
const punchLine = (r: AttendanceRecord) => r.punches.map((p) => `${p.kind === 'in' ? 'In' : 'Out'} ${time(p.at, tz.value)} (${SOURCE_LABEL[p.source] ?? p.source})`).join(' · ');
const CORRECTION_KIND: Record<string, string> = { add_in: 'Add time-in', add_out: 'Add time-out', void_punch: 'Remove a wrong punch' };
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
        <div class="mx-auto max-w-3xl space-y-5">
          <PageHeader title="Attendance" description="Time in and out at your unit’s QR station. Your department head verifies each duty; mistakes are fixed through a correction." />

          <section class="card p-5" aria-labelledby="punch-h">
            <h2 id="punch-h" class="text-[15px] font-semibold">Time in or out</h2>
            <p class="mt-1 text-[13px] text-ink-3">Scan the code on the station screen, or type the 6 digits it shows. It changes every 30 seconds.</p>
            <div v-if="scanning" class="mt-4">
              <video ref="video" class="aspect-square w-full max-w-xs rounded-lg bg-ink object-cover" playsinline muted aria-label="Camera preview" />
              <UiButton class="mt-3" size="sm" variant="ghost" @click="stopScan">Stop scanning</UiButton>
            </div>
            <div v-else class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <UiButton v-if="canScan" variant="primary" :loading="busy" @click="startScan">Scan the station</UiButton>
              <form class="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end" @submit.prevent="submitCode">
                <UiField v-if="(data?.stations.length ?? 0) > 1" v-slot="{ labelledby }" label="Station" class="sm:w-44">
                  <IonSelect v-model="stationId" class="field-input" interface="popover" :aria-labelledby="labelledby" placeholder="Choose">
                    <IonSelectOption v-for="s in data?.stations" :key="s.id" :value="s.id">{{ s.name }}</IonSelectOption>
                  </IonSelect>
                </UiField>
                <UiField v-slot="{ id, labelledby }" label="Code" class="sm:w-36">
                  <IonInput :id="id" v-model="code" :aria-labelledby="labelledby" class="field-input tnum" inputmode="numeric" :maxlength="6" placeholder="000000" autocomplete="off" />
                </UiField>
                <UiButton type="submit" :variant="canScan ? 'secondary' : 'primary'" :loading="busy && !scanning">Record</UiButton>
              </form>
            </div>
            <p v-if="scanError" role="alert" class="mt-3 text-[13px] text-bad">{{ scanError }}</p>
          </section>

          <StateBlock :loading="loading" :error="error" @retry="reload()">
            <section v-if="data?.exceptions.length" class="card border-warn/30 p-5" aria-labelledby="fix-h">
              <h2 id="fix-h" class="text-[15px] font-semibold">To fix</h2>
              <ul class="mt-2 space-y-1.5 text-[14px]">
                <li v-for="x in data.exceptions" :key="x.id" class="flex flex-wrap gap-x-2">
                  <span class="font-medium text-warn">{{ EXCEPTION_LABEL[x.kind] ?? x.kind }}</span>
                  <span class="text-ink-2">{{ x.shift_label ? `${x.shift_label}, ${day(`${x.shift_date}T12:00:00`)}` : x.detail }}</span>
                </li>
              </ul>
            </section>

            <section class="card mt-5" aria-labelledby="duties-h">
              <h2 id="duties-h" class="px-5 pt-4 text-[15px] font-semibold">Your duties, last 14 days</h2>
              <p v-if="!data?.records.length" class="px-5 pt-2 pb-5 text-[14px] text-ink-3">No duties recorded yet.</p>
              <ul v-else class="mt-2 divide-y divide-line">
                <li v-for="r in data.records" :key="r.id" class="px-5 py-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ r.shift_label }}, {{ day(r.scheduled_start, tz) }}</span>
                    <StatusBadge :tone="recordStatus(r).tone" :label="recordStatus(r).label" />
                  </div>
                  <p class="mt-1 text-[13px] text-ink-2 tnum">
                    {{ time(r.scheduled_start, tz) }}–{{ time(r.scheduled_end, tz) }} ·
                    In {{ r.time_in ? time(r.time_in, tz) : '—' }} · Out {{ r.time_out ? time(r.time_out, tz) : '—' }}
                    <template v-if="r.late_minutes"> · late {{ minutes(r.late_minutes) }}</template>
                    <template v-if="r.undertime_minutes"> · left {{ minutes(r.undertime_minutes) }} early</template>
                    <template v-if="r.overtime_approved_minutes"> · overtime {{ minutes(r.overtime_approved_minutes) }} ({{ r.overtime_treatment === 'pay' ? 'paid' : 'compensatory time' }})</template>
                  </p>
                  <p v-if="r.punches.length" class="mt-0.5 text-[12px] text-ink-3">
                    {{ punchLine(r) }}
                  </p>
                  <div v-if="!r.locked_at && ['incomplete', 'no_show', 'absent', 'clocked_in'].includes(r.status)" class="mt-2 flex gap-2">
                    <UiButton v-if="!r.time_in" size="sm" variant="ghost" @click="openCorrection(r, 'add_in')">Add missing time-in</UiButton>
                    <UiButton v-if="!r.time_out && r.status !== 'clocked_in'" size="sm" variant="ghost" @click="openCorrection(r, 'add_out')">Add missing time-out</UiButton>
                  </div>
                </li>
              </ul>
            </section>

            <section v-if="data?.corrections.length" class="card mt-5" aria-labelledby="corr-h">
              <h2 id="corr-h" class="px-5 pt-4 text-[15px] font-semibold">Your correction requests</h2>
              <ul class="mt-2 divide-y divide-line">
                <li v-for="k in data.corrections" :key="k.id" class="flex flex-wrap items-center gap-2 px-5 py-3 text-[14px]">
                  <span class="font-medium">{{ CORRECTION_KIND[k.kind] }}</span>
                  <span v-if="k.proposed_at" class="text-ink-2 tnum">{{ day(k.proposed_at, tz) }} {{ time(k.proposed_at, tz) }}</span>
                  <StatusBadge :tone="k.status === 'approved' ? 'ok' : k.status === 'rejected' ? 'bad' : 'warn'" :label="k.status === 'pending' ? 'Waiting' : k.status === 'approved' ? 'Approved' : 'Not approved'" />
                  <span v-if="k.decision_note" class="w-full text-[13px] text-ink-3">{{ k.decision_note }}</span>
                </li>
              </ul>
            </section>
          </StateBlock>
        </div>

        <UiDialog :open="Boolean(correcting)" :title="correcting ? CORRECTION_KIND[correcting.kind]! : ''" :description="correcting?.label" @close="correcting = null">
          <form v-if="correcting" id="correction-form" class="space-y-4" @submit.prevent="sendCorrection">
            <UiField v-slot="{ id, labelledby }" label="Actual time">
              <IonInput :id="id" v-model="correcting.at" :aria-labelledby="labelledby" class="field-input" type="datetime-local" />
            </UiField>
            <UiField v-slot="{ id, labelledby }" label="What happened" hint="For example: the station was down, or my phone battery died.">
              <IonTextarea :id="id" v-model="correcting.reason" :aria-labelledby="labelledby" class="field-input" :rows="2" :maxlength="500" auto-grow />
            </UiField>
            <p v-if="correctionError" role="alert" class="text-[13px] text-bad">{{ correctionError }}</p>
          </form>
          <template #footer>
            <UiButton variant="ghost" @click="correcting = null">Cancel</UiButton>
            <UiButton variant="primary" type="submit" form="correction-form" :loading="saving">Send to department head</UiButton>
          </template>
        </UiDialog>
      </div>
    </IonContent>
  </IonPage>
</template>
