<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ path: string }>();
const lines = computed(() => {
  const p = props.path;
  // The Head Nurse's Today is their home; approvals get a checked box (Schedule keeps the calendar).
  if (p === '/manager/shifts') return ['m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8'];
  if (p === '/manager') return ['M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9', 'm9 11 3 3 8-8'];
  if (p === '/menu') return ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'];
  if (p.includes('attendance')) return ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'];
  if (p.includes('dtr')) return ['M6 3h8l4 4v14H6z', 'M14 3v5h4', 'm9 14 2 2 4-4'];
  if (p.includes('payslips') || p.includes('payroll')) return ['M3 6h18v12H3z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v.01M18 15v.01'];
  if (p === '/hr') return ['M4 5h16v14H4z', 'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 5c.5-1.7 1.6-2.5 3-2.5s2.5.8 3 2.5M14 9h4m-4 4h3'];
  if (p.includes('team')) return ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3a4 4 0 0 1 0 8'];
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
