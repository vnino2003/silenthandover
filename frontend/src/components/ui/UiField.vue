<script setup lang="ts">
import { useId } from 'vue';

/**
 * A labelled form field. The slot receives the ids to put on the control (an Ionic IonInput,
 * IonTextarea or IonSelect): `labelledby` names it for screen readers, `describedby` its hint.
 */
defineProps<{ label?: string; hint?: string; error?: string | null; optional?: boolean }>();
const id = useId();
</script>

<template>
  <div class="space-y-1.5">
    <label v-if="label" :id="`${id}-label`" :for="id" class="flex items-baseline justify-between gap-3 text-[14px] font-medium text-ink">
      <span>{{ label }}</span>
      <span v-if="optional" class="text-[12px] font-normal text-ink-3">Optional</span>
    </label>
    <p v-if="hint" :id="`${id}-hint`" class="text-[13px] leading-snug text-ink-3">{{ hint }}</p>
    <slot :id="id" :labelledby="label ? `${id}-label` : undefined" :invalid="Boolean(error)" :describedby="hint ? `${id}-hint` : undefined" />
    <p v-if="error" class="text-[13px] text-bad" role="alert">{{ error }}</p>
  </div>
</template>
