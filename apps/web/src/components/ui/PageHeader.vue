<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string; description?: string }>();
</script>

<template>
  <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <p v-if="eyebrow" class="eyebrow mb-1">{{ eyebrow }}</p>
      <h1 class="text-[22px] leading-tight font-semibold tracking-[-0.01em] sm:text-[24px]">{{ title }}</h1>
      <p v-if="description" class="mt-1.5 max-w-2xl text-[14px] text-ink-2">{{ description }}</p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.default" class="flex shrink-0 flex-wrap gap-2"><slot /></div>
  </header>
</template>
