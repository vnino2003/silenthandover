<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonModal } from '@ionic/vue';

/**
 * The app's dialog, built on Ionic's IonModal (focus trap, Escape and backdrop handled by Ionic).
 * The page decides when it closes: Escape or a tap outside asks the page (`close`), so a dialog
 * that is still saving stays open.
 */
const props = defineProps<{ open: boolean; title: string; description?: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const body = ref<HTMLElement | null>(null);

async function canDismiss() {
  if (!props.open) return true;
  emit('close');
  return false;
}
// Focus the first field or action, not the close button in the header.
function focusFirst() {
  const target = body.value?.querySelector<HTMLElement>('[autofocus], ion-input, ion-textarea, ion-select, input:not([type=hidden]):not(.sr-only), textarea, select');
  if (target && 'setFocus' in target) (target as unknown as { setFocus: () => void }).setFocus();
  else target?.focus({ preventScroll: true });
}
</script>

<template>
  <IonModal :is-open="open" :can-dismiss="canDismiss" class="sh-modal" :class="{ 'sh-modal-wide': wide }" :aria-label="title" @did-present="focusFirst">
    <div class="ion-page dialog-panel flex max-h-[inherit] flex-col bg-surface">
      <div class="flex items-start gap-3 border-b border-line px-5 pt-4 pb-4">
        <div class="min-w-0 flex-1">
          <h2 class="text-[16px] font-semibold">{{ title }}</h2>
          <p v-if="description" class="mt-1 text-[14px] text-ink-2">{{ description }}</p>
        </div>
        <IonButton fill="clear" class="sh-ghost sh-sm -mt-1 -mr-2" aria-label="Close" @click="emit('close')">
          <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </IonButton>
      </div>
      <div v-if="$slots.default" ref="body" class="dialog-body min-h-0 flex-1 overflow-y-auto px-5 py-4"><slot /></div>
      <div v-if="$slots.footer" class="dialog-footer flex flex-col-reverse gap-2 border-t border-line bg-canvas/60 px-5 py-3 sm:flex-row sm:justify-end">
        <slot name="footer" />
      </div>
    </div>
  </IonModal>
</template>
