<script setup lang="ts">
/** Generated Silent Handover brand mark next to the product name. */
withDefaults(defineProps<{ size?: number; showName?: boolean }>(), { size: 28, showName: true });
</script>

<template>
  <span class="inline-flex items-center gap-2.5">
    <img src="/silent-handover-logo.png" alt="" aria-hidden="true" class="shrink-0 object-contain" :width="size" :height="size" />
    <span v-if="showName">Silent Handover</span>
  </span>
</template>
