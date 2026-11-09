<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import BrandMark from '@/components/BrandMark.vue';
import ToastHost from '@/components/ui/ToastHost.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { useAuth } from '@/stores/auth';
import { isNative, online } from '@/lib/native';
import { apiBase, setApiBase } from '@/lib/api';
import { IonInput } from '@ionic/vue';

const auth = useAuth();
const retry = () => window.location.reload();
// Android app only: which server to connect to (the built-in address, or one saved here).
const server = ref(isNative ? apiBase() : '');
const serverError = ref('');
function saveServer() {
  serverError.value = setApiBase(server.value) ?? '';
  if (!serverError.value) retry();
}

// A thin bar at the top while a page is loading. It only appears when loading takes long
// enough to notice, so quick navigations stay calm.
const router = useRouter();
const navigating = ref(false);
const finishing = ref(false);
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const stopStart = router.beforeEach(() => {
  if (hideTimer) clearTimeout(hideTimer);
  finishing.value = false;
  showTimer = setTimeout(() => (navigating.value = true), 120);
});
const done = () => {
  if (showTimer) clearTimeout(showTimer);
  if (!navigating.value) return;
  finishing.value = true;
  hideTimer = setTimeout(() => {
    navigating.value = false;
    finishing.value = false;
  }, 250);
};
const stopEnd = router.afterEach(done);
const stopError = router.onError(done);
onBeforeUnmount(() => {
  stopStart();
  stopEnd();
  stopError();
});
</script>

<template>
  <IonApp>
  <div v-if="navigating" class="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5" aria-hidden="true">
    <div
      class="h-full bg-accent"
      :class="finishing ? 'w-full opacity-0 transition-[opacity] duration-200' : 'nav-progress w-full'"
    />
  </div>
  <div v-if="auth.bootError" class="grid min-h-dvh place-items-center px-4">
    <div class="max-w-sm text-center" role="alert">
      <p class="text-[15px] font-semibold"><BrandMark /></p>
      <h1 class="mt-6 text-[20px] font-semibold">Can’t connect</h1>
      <p class="mt-2 text-[14px] text-ink-2">{{ auth.bootError }} Check your connection, or try again in a moment.</p>
      <UiButton v-if="!isNative" class="mt-6" variant="primary" @click="retry">Try again</UiButton>
      <form v-else class="mt-6 space-y-3 text-left" @submit.prevent="saveServer">
        <label class="block text-[13px] font-medium" for="server-address">Server address</label>
        <IonInput id="server-address" v-model="server" class="field-input" type="url" inputmode="url" placeholder="https://api.yourhospital.ph" autocomplete="off" :spellcheck="false" />
        <p v-if="serverError" role="alert" class="text-[13px] text-bad">{{ serverError }}</p>
        <UiButton type="submit" variant="primary" block>Save and connect</UiButton>
      </form>
    </div>
  </div>
  <IonRouterOutlet v-else />
  <div v-if="!online" class="fixed inset-x-0 bottom-0 z-[90] bg-ink px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-center text-[13px] text-white" role="status">
    You’re offline. What you type is kept; it is sent when the connection is back.
  </div>
  <ToastHost />
  </IonApp>
</template>
