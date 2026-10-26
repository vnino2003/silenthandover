<script setup lang="ts">
import { useToast } from '@/stores/toast';
const toast = useToast();
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
    <TransitionGroup name="fade">
      <div
        v-for="t in toast.toasts"
        :key="t.id"
        class="pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg px-4 py-3 text-[14px] shadow-pop"
        :class="t.tone === 'bad' ? 'bg-bad text-white' : 'bg-ink text-white'"
        :role="t.tone === 'bad' ? 'alert' : 'status'"
      >
        <span class="flex-1">{{ t.text }}</span>
        <button class="text-white/70 hover:text-white" aria-label="Dismiss" @click="toast.dismiss(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>
