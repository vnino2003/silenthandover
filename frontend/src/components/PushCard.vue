<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import UiButton from '@/components/ui/UiButton.vue';
import { errorMessage } from '@/lib/api';
import { isNative } from '@/lib/native';
import { disablePush, enablePush, installApp, installOffer, isIos, pushState, runningInstalled, sendTestAlert, syncPush } from '@/lib/push';
import { useToast } from '@/stores/toast';

/** Phone and desktop alerts for this device. `prompt` = the short version shown only while alerts are off. */
const props = defineProps<{ prompt?: boolean }>();
const toast = useToast();
const busy = ref(false);
onMounted(() => void syncPush());

const canInstall = computed(() => !!installOffer.value && !runningInstalled.value);
const visible = computed(() => !props.prompt || pushState.value === 'off' || canInstall.value);

async function run(fn: () => Promise<unknown>, ok?: string) {
  busy.value = true;
  try {
    await fn();
    if (ok) toast.ok(ok);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
const turnOn = () =>
  run(async () => {
    const s = await enablePush();
    if (s === 'on') toast.ok('Alerts are on for this device');
    else if (s === 'blocked') toast.error('Alerts are blocked. Allow notifications for this site in your browser settings.');
  });
</script>

<template>
  <section v-if="visible" class="card p-5" aria-label="Alerts on this device">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div class="min-w-0 flex-1">
        <h2 class="text-[15px] font-semibold">
          {{ pushState === 'on' ? 'Alerts are on for this device' : 'Get alerts on this device' }}
        </h2>
        <p v-if="pushState === 'on'" class="mt-1 text-[13px] text-ink-3">
          New shifts, leave decisions, endorsements to approve or acknowledge, and follow-ups show here right away, even when the app is closed.
        </p>
        <p v-else-if="pushState === 'off'" class="mt-1 text-[13px] text-ink-3">
          Get new shifts, leave decisions, endorsements to approve or acknowledge, and follow-ups on this device right away, even when the app is closed.
          Alerts show the title only, never endorsement content.
        </p>
        <p v-else-if="pushState === 'blocked'" class="mt-1 text-[13px] text-warn">
          Alerts are blocked for this site. Allow notifications in your browser’s site settings, then turn them on here.
        </p>
        <p v-else-if="isNative" class="mt-1 text-[13px] text-ink-3">
          Alerts on the lock screen come from the web app. Open Silent Handover in Chrome on this phone, choose <b>Install app</b>, and turn alerts on there.
        </p>
        <p v-else-if="isIos && !runningInstalled" class="mt-1 text-[13px] text-ink-3">
          On iPhone and iPad, tap <b>Share</b> → <b>Add to Home Screen</b>, open Silent Handover from your Home Screen, and turn alerts on there.
        </p>
        <p v-else class="mt-1 text-[13px] text-ink-3">This browser can’t show alerts. Use Chrome, Edge or Firefox.</p>
        <p v-if="canInstall" class="mt-2 text-[13px] text-ink-3">Install the app to open it from your home screen or desktop like any other app.</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <UiButton v-if="canInstall" size="sm" :disabled="busy" @click="run(installApp)">Install app</UiButton>
        <UiButton v-if="pushState === 'off'" size="sm" variant="primary" :loading="busy" @click="turnOn">Turn on alerts</UiButton>
        <template v-if="pushState === 'on' && !prompt">
          <UiButton size="sm" :disabled="busy" @click="run(sendTestAlert, 'Test alert sent')">Send a test</UiButton>
          <UiButton size="sm" variant="ghost" :disabled="busy" @click="run(disablePush, 'Alerts are off for this device')">Turn off</UiButton>
        </template>
      </div>
    </div>
  </section>
</template>
