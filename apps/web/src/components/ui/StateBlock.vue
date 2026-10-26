<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

/**
 * Loading, error and empty states in one place so every page treats them the same way.
 * The skeleton waits a moment before appearing, so fast loads don't flash. While `refreshing`,
 * the current content stays on screen, slightly dimmed.
 */
const props = defineProps<{
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyTitle?: string;
  emptyText?: string;
  lines?: number;
}>();
defineEmits<{ retry: [] }>();

const showSkeleton = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.loading,
  (loading) => {
    if (timer) clearTimeout(timer);
    if (!loading) showSkeleton.value = false;
    else timer = setTimeout(() => (showSkeleton.value = true), 150);
  },
  { immediate: true },
);
onBeforeUnmount(() => timer && clearTimeout(timer));
</script>

<template>
  <div v-if="loading" aria-busy="true" aria-label="Loading">
    <div v-if="showSkeleton" class="card divide-y divide-line overflow-hidden">
      <div v-for="i in Math.min(lines ?? 3, 8)" :key="i" class="flex items-center gap-4 px-5 py-4">
        <div class="min-w-0 flex-1 space-y-2">
          <div class="skeleton h-3.5 rounded" :style="{ width: `${68 - ((i * 13) % 30)}%` }" />
          <div class="skeleton h-3 rounded" :style="{ width: `${42 - ((i * 7) % 18)}%` }" />
        </div>
        <div class="skeleton hidden h-6 w-20 rounded-full sm:block" />
      </div>
    </div>
  </div>
  <div v-else-if="error" class="enter-fade rounded-lg border border-bad/25 bg-bad-soft px-4 py-3 text-[14px] text-bad" role="alert">
    <p>{{ error }}</p>
    <button class="mt-1 font-medium underline underline-offset-2" @click="$emit('retry')">Try again</button>
  </div>
  <div v-else-if="empty" class="enter-fade rounded-lg border border-dashed border-line-strong px-5 py-8 text-center" :class="{ 'opacity-60': refreshing }">
    <p class="text-[14px] font-medium text-ink">{{ emptyTitle ?? 'Nothing here yet' }}</p>
    <p v-if="emptyText" class="mx-auto mt-1 max-w-sm text-[13px] text-ink-3">{{ emptyText }}</p>
    <div v-if="$slots.action" class="mt-4"><slot name="action" /></div>
  </div>
  <div v-else class="enter-fade transition-opacity duration-200" :class="refreshing ? 'pointer-events-none opacity-60' : 'opacity-100'" :aria-busy="refreshing || undefined">
    <slot />
  </div>
</template>
