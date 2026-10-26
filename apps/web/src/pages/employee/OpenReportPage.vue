<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';

// Resolves (or creates) the employee's report for a shift, then opens it.
const route = useRoute();
const router = useRouter();
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const { report_id } = await api.post<{ report_id: string }>(`/shifts/${route.params.shiftId}/report`);
    router.replace(`/reports/${report_id}`);
  } catch (err) {
    error.value = errorMessage(err);
  }
});
</script>

<template>
  <div class="mx-auto max-w-lg py-16 text-center">
    <template v-if="error">
      <h1 class="text-[18px] font-semibold">You can’t open this report right now</h1>
      <p class="mt-2 text-[14px] text-ink-2">{{ error }}</p>
      <UiButton class="mt-6" to="/">Back to today</UiButton>
    </template>
    <p v-else class="text-[14px] text-ink-3">Opening your report…</p>
  </div>
</template>
