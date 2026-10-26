<script setup lang="ts">
/** Loading, error and empty states in one place so every page treats them the same way. */
defineProps<{ loading?: boolean; error?: string | null; empty?: boolean; emptyTitle?: string; emptyText?: string; lines?: number }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading" class="space-y-3 py-2" aria-busy="true" aria-label="Loading">
    <div v-for="i in lines ?? 3" :key="i" class="h-4 animate-pulse rounded bg-sunken" :style="{ width: `${92 - i * 14}%` }" />
  </div>
  <div v-else-if="error" class="rounded-lg border border-bad/25 bg-bad-soft px-4 py-3 text-[14px] text-bad" role="alert">
    <p>{{ error }}</p>
    <button class="mt-1 font-medium underline underline-offset-2" @click="$emit('retry')">Try again</button>
  </div>
  <div v-else-if="empty" class="rounded-lg border border-dashed border-line-strong px-5 py-8 text-center">
    <p class="text-[14px] font-medium text-ink">{{ emptyTitle ?? 'Nothing here yet' }}</p>
    <p v-if="emptyText" class="mx-auto mt-1 max-w-sm text-[13px] text-ink-3">{{ emptyText }}</p>
    <div v-if="$slots.action" class="mt-4"><slot name="action" /></div>
  </div>
  <slot v-else />
</template>
