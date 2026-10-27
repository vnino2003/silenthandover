<script setup lang="ts">
withDefaults(defineProps<{ size?: number; thinking?: boolean }>(), { size: 40 });
</script>
<template><img src="/assistant/mica.png" alt="" aria-hidden="true" :width="size" :height="size" class="mica-mascot shrink-0 object-contain" :class="{ 'mica-thinking': thinking }" :style="{ width: `${size}px`, height: `${size}px` }" /></template>
