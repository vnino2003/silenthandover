<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ path: string }>();
const lines = computed(() => {
  const p = props.path;
  if (p.includes('assistant') || p.includes('ai-pipeline')) return ['m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z'];
  if (p.includes('leave')) return ['M5 5h14v15H5z', 'M8 3v4m8-4v4M5 10h14', 'm9.5 15 2 2 3.5-3.5'];
  if (p.includes('schedule') || p.includes('shifts')) return ['M5 5h14v15H5z', 'M8 3v4m8-4v4M5 10h14m-10 4h2m2 3h2'];
  if (p.includes('tasks') || p.includes('issues')) return ['m12 3 10 18H2L12 3Z', 'M12 9v5m0 3h.01'];
  if (p.includes('handover')) return ['M4 7h14m-4-4 4 4-4 4M20 17H6m4-4-4 4 4 4'];
  if (p.includes('users') || p.includes('departments')) return ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3a4 4 0 0 1 0 8'];
  if (p.includes('reports') || p.includes('records') || p.includes('audit')) return ['M6 3h8l4 4v14H6z', 'M14 3v5h4M9 12h6m-6 4h6'];
  if (p.includes('settings')) return ['M4 7h16M4 17h16M8 4v6m8 4v6'];
  if (p === '/admin') return ['M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4'];
  return ['m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8'];
});
</script>
<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-5 shrink-0">
    <path v-for="line in lines" :key="line" :d="line" />
  </svg>
</template>
