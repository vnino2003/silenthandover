<script lang="ts">
// One cache for every avatar on the page, so each picture version is downloaded once.
const cache = new Map<string, Promise<string | null>>();
</script>

<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { fetchBlob } from '@/lib/api';

/**
 * A person's profile picture, or their initials when they have none. Pictures are fetched with
 * the session token (the API checks who may see them); `version` changes when the picture does.
 */
const props = withDefaults(defineProps<{ id: string; name: string; version?: number | null; size?: number }>(), { version: null, size: 32 });

const src = ref<string | null>(null);
watchEffect(async () => {
  const { id, version } = props;
  if (!version) {
    src.value = null;
    return;
  }
  const key = `${id}:${version}`;
  if (!cache.has(key)) cache.set(key, fetchBlob(`/profile-photos/${id}?v=${version}`).then((b) => URL.createObjectURL(b)).catch(() => null));
  const url = await cache.get(key)!;
  if (props.id === id && props.version === version) src.value = url;
});

const initials = computed(() =>
  props.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join(''),
);
</script>

<template>
  <span
    class="inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-sunken font-semibold text-ink-2 select-none"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(10, Math.round(size * 0.34))}px` }"
    :title="name"
  >
    <img v-if="src" :src="src" :alt="name" class="size-full object-cover" />
    <template v-else>
      <span aria-hidden="true">{{ initials }}</span>
      <span class="sr-only">{{ name }}</span>
    </template>
  </span>
</template>
