<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DepartmentBoard from '@/components/DepartmentBoard.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/useAsync';

/**
 * Read-only staffing across the organisation. Administrators set scheduling rules and leave types;
 * supervisors own and change the schedules. Leave reasons are never shown here.
 */
const departments = useAsync(() => api.get<{ id: string; name: string }[]>('/admin/departments'));
const departmentId = ref('');
watch(departments.data, (d) => !departmentId.value && d?.[0] && (departmentId.value = d[0].id));
const endpoint = computed(() => `/admin/board?department_id=${departmentId.value}`);
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <PageHeader title="Schedules" description="Staffing for every department, read-only. Supervisors change their own department’s schedule.">
      <select v-model="departmentId" class="field-input h-9 w-56 py-0 text-[14px]" aria-label="Department">
        <option v-for="d in departments.data.value ?? []" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
    </PageHeader>
    <StateBlock :loading="departments.loading.value" :error="departments.error.value" :empty="!departments.data.value?.length" empty-title="No departments yet" @retry="departments.reload()">
      <DepartmentBoard v-if="departmentId" :key="departmentId" :endpoint="endpoint" readonly />
    </StateBlock>
  </div>
</template>
