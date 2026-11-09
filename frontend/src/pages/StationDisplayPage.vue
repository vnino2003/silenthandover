<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue';
import QRCode from 'qrcode';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import { apiBase } from '@/lib/api';

/**
 * The QR station: a tablet at the unit's staff-only station shows this page full screen. It proves
 * itself with the station key from the setup link (kept on this device only), never a staff
 * account, and shows a code that changes every 30 seconds.
 */
const route = useRoute();
const id = String(route.params.id);
const KEY = `sh.station.${id}`;
const key = ref('');
const name = ref('');
const code = ref('');
const svg = ref('');
const left = ref(30);
const problem = ref('');
let poll: ReturnType<typeof setTimeout> | null = null;
let tick: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const res = await fetch(`${apiBase()}/api/stations/${id}/code`, { headers: { 'X-Station-Key': key.value } });
    if (!res.ok) {
      problem.value = res.status === 401 ? 'This station is not set up or its key was reset. Open the setup link from the department head again.' : 'Can’t reach the server. Retrying…';
      poll = setTimeout(refresh, 5000);
      return;
    }
    const body = (await res.json()) as { station: string; code: string; qr: string; expires_in_ms: number };
    problem.value = '';
    name.value = body.station;
    code.value = body.code;
    svg.value = await QRCode.toString(body.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    left.value = Math.ceil(body.expires_in_ms / 1000);
    poll = setTimeout(refresh, Math.max(1000, body.expires_in_ms + 300));
  } catch {
    problem.value = 'Can’t reach the server. Retrying…';
    poll = setTimeout(refresh, 5000);
  }
}

onMounted(() => {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get('key');
  try {
    if (fromLink) {
      localStorage.setItem(KEY, fromLink);
      history.replaceState(null, '', window.location.pathname);
    }
    key.value = fromLink ?? localStorage.getItem(KEY) ?? '';
  } catch {
    key.value = fromLink ?? '';
  }
  if (!key.value) {
    problem.value = 'Open this page with the setup link from the department head.';
    return;
  }
  void refresh();
  tick = setInterval(() => (left.value = Math.max(0, left.value - 1)), 1000);
});
onBeforeUnmount(() => {
  if (poll) clearTimeout(poll);
  if (tick) clearInterval(tick);
});
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <main class="grid min-h-dvh place-items-center bg-surface px-4 py-8 text-center">
        <div class="w-full max-w-md">
          <BrandMark />
          <h1 class="mt-4 text-[22px] font-semibold">{{ name || 'Attendance station' }}</h1>
          <p class="mt-1 text-[14px] text-ink-2">Open Attendance in Silent Handover and scan this code, or type the 6 digits.</p>
          <p v-if="problem" role="alert" class="mt-6 rounded-md bg-warn-soft px-4 py-3 text-[14px] text-warn">{{ problem }}</p>
          <template v-else-if="code">
            <!-- The SVG is generated locally from the station's own code. -->
            <div class="mx-auto mt-6 w-72 max-w-full rounded-xl bg-white p-3 shadow-sm" role="img" :aria-label="`QR code for ${code}`" v-html="svg" />
            <p class="mt-5 text-[44px] font-semibold tracking-[0.25em] tnum" aria-live="polite">{{ code }}</p>
            <p class="text-[13px] text-ink-3">Changes in {{ left }} s</p>
          </template>
          <p class="mt-8 text-[12px] text-ink-3">Staff only. Use your own account; attendance is checked by your department head.</p>
        </div>
      </main>
    </IonContent>
  </IonPage>
</template>
