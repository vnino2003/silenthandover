<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchBlob } from '@/lib/api';

/** A photo attached to an issue. Loaded with the session token; opens full size on click. */
const props = defineProps<{ photoId: string; alt: string }>();
const src = ref<string | null>(null);
const failed = ref(false);
const open = ref(false);

onMounted(async () => {
  try {
    src.value = URL.createObjectURL(await fetchBlob(`/issue-photos/${props.photoId}`));
  } catch {
    failed.value = true;
  }
});
onBeforeUnmount(() => src.value && URL.revokeObjectURL(src.value));
</script>

<template>
  <span v-if="failed" class="text-[12.5px] text-ink-3">Photo unavailable</span>
  <button v-else type="button" class="block overflow-hidden rounded-md border border-line bg-sunken" :aria-label="`Open photo: ${alt}`" @click="open = true">
    <img v-if="src" :src="src" :alt="alt" class="h-24 w-32 object-cover" />
    <span v-else class="block h-24 w-32 animate-pulse" />
  </button>
  <Teleport to="body">
    <div v-if="open && src" class="fixed inset-0 z-[70] grid place-items-center bg-ink/80 p-4" role="dialog" aria-modal="true" :aria-label="alt" @click="open = false">
      <img :src="src" :alt="alt" class="max-h-[90vh] max-w-full rounded-md" />
    </div>
  </Teleport>
</template>
