<script setup lang="ts">
import { RouterView } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import ToastHost from '@/components/ui/ToastHost.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { useAuth } from '@/stores/auth';

const auth = useAuth();
const retry = () => window.location.reload();
</script>

<template>
  <div v-if="auth.bootError" class="grid min-h-dvh place-items-center px-4">
    <div class="max-w-sm text-center" role="alert">
      <p class="text-[15px] font-semibold"><BrandMark /></p>
      <h1 class="mt-6 text-[20px] font-semibold">Can’t connect</h1>
      <p class="mt-2 text-[14px] text-ink-2">{{ auth.bootError }} Check your connection, or try again in a moment.</p>
      <UiButton class="mt-6" variant="primary" @click="retry">Try again</UiButton>
    </div>
  </div>
  <RouterView v-else />
  <ToastHost />
</template>
