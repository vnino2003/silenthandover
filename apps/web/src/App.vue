<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonApp, IonRouterOutlet } from '@ionic/vue';
import BrandMark from '@/components/BrandMark.vue';
import ToastHost from '@/components/ui/ToastHost.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { useAuth } from '@/stores/auth';

const auth = useAuth();
const retry = () => window.location.reload();

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
      <UiButton class="mt-6" variant="primary" @click="retry">Try again</UiButton>
    </div>
  </div>
  <IonRouterOutlet v-else />
  <ToastHost />
  </IonApp>
</template>
