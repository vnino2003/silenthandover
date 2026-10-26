<script setup lang="ts">
import type { IssueSeverity } from '@sh/shared';
defineProps<{ severity: IssueSeverity; safety?: boolean }>();
const tone: Record<IssueSeverity, string> = {
  critical: 'text-bad',
  high: 'text-bad',
  medium: 'text-warn',
  low: 'text-ink-3',
};
</script>

<template>
  <span class="inline-flex items-center gap-2 text-[12px] font-medium">
    <span :class="tone[severity]" class="capitalize">{{ severity }}</span>
    <span v-if="safety" class="rounded-sm bg-bad px-1.5 py-px text-[11px] font-semibold tracking-wide text-white uppercase">Safety</span>
  </span>
</template>
