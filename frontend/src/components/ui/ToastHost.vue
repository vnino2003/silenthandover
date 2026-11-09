<script setup lang="ts">
import { computed } from 'vue';
import { IonToast } from '@ionic/vue';
import { useToast } from '@/stores/toast';

/**
 * Toasts, built on Ionic's IonToast. The store decides how long each one stays; the newest is
 * shown (and kept while the pointer is over it), older ones finish in the background.
 */
const toast = useToast();
const latest = computed(() => toast.toasts.at(-1) ?? null);
const COLOR = { ok: 'dark', info: 'dark', bad: 'danger' } as const;
</script>

<template>
  <IonToast
    v-if="latest"
    :key="latest.id"
    :is-open="true"
    :message="latest.text"
    :color="COLOR[latest.tone]"
    :duration="0"
    position="bottom"
    class="sh-toast"
    :role="latest.tone === 'bad' ? 'alert' : 'status'"
    :buttons="[{ text: 'Dismiss', role: 'cancel', handler: () => toast.dismiss(latest!.id) }]"
    @mouseenter="toast.hold(latest.id)"
    @mouseleave="toast.release(latest.id)"
  />
</template>
