<script setup lang="ts">
import { useToast } from '@/stores/toast';
const toast = useToast();
const MARK = { ok: 'bg-[#5fd39a]', info: 'bg-[#8fb4ff]', bad: 'bg-white' } as const;
</script>

<template>
  <div class="toast-host pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toast.toasts"
        :key="t.id"
        class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg px-4 py-3 text-[14px] shadow-pop"
        :class="t.tone === 'bad' ? 'bg-bad text-white' : 'bg-ink text-white'"
        :role="t.tone === 'bad' ? 'alert' : 'status'"
        @mouseenter="toast.hold(t.id)"
        @mouseleave="toast.release(t.id)"
      >
        <span class="mt-[7px] size-2 shrink-0 rounded-full" :class="MARK[t.tone]" aria-hidden="true" />
        <span class="flex-1">{{ t.text }}</span>
        <button class="-mr-1 grid size-6 shrink-0 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white" aria-label="Dismiss" @click="toast.dismiss(t.id)">
          <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
