<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string; description?: string }>();
</script>

<template>
  <header class="page-header mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <p v-if="eyebrow" class="eyebrow mb-1">{{ eyebrow }}</p>
      <h1 class="text-[25px] leading-tight font-semibold tracking-[-0.035em] sm:text-[30px]">{{ title }}</h1>
      <p v-if="description" class="mt-1.5 max-w-2xl text-[14px] text-ink-2">{{ description }}</p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.default" class="flex shrink-0 flex-wrap gap-2"><slot /></div>
  </header>
</template>
