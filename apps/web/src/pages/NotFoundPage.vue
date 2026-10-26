<script setup lang="ts">
import UiButton from '@/components/ui/UiButton.vue';
import { useAuth } from '@/stores/auth';
const auth = useAuth();
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-4">
    <div class="text-center">
      <p class="eyebrow">404</p>
      <h1 class="mt-2 text-[22px] font-semibold">This page doesn’t exist</h1>
      <p class="mt-1 text-[14px] text-ink-2">The link may be old, or you may not have access to it.</p>
      <UiButton class="mt-6" variant="primary" :to="auth.profile ? auth.homePath : '/login'">Go back</UiButton>
    </div>
  </div>
</template>
