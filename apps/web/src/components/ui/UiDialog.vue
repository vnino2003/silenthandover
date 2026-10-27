<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ open: boolean; title: string; description?: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
let previous: Element | null = null;

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
  if (e.key === 'Tab' && panel.value) {
    const focusable = panel.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const list = [...focusable].filter((el) => !el.hasAttribute('disabled'));
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previous = document.activeElement;
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
      await nextTick();
      // Focus the first field or action, not the close button in the header.
      const body = panel.value?.querySelector<HTMLElement>('.dialog-body');
      (
        body?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]):not(.sr-only), textarea, select') ??
        // Read-only summaries start at the top, not scrolled down to the footer action.
        panel.value
      )?.focus({ preventScroll: true });
    } else {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      (previous as HTMLElement | null)?.focus?.();
    }
  },
);
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-0 backdrop-blur-[1px] sm:items-center sm:p-6" @mousedown.self="emit('close')">
        <div
          ref="panel"
          role="dialog"
          tabindex="-1"
          aria-modal="true"
          :aria-label="title"
          class="dialog-panel max-h-[92dvh] w-full overflow-y-auto rounded-t-xl bg-surface shadow-pop sm:rounded-lg"
          :class="wide ? 'sm:max-w-2xl' : 'sm:max-w-md'"
        >
          <!-- On phones the dialog is a bottom sheet; the handle shows it can be dismissed. -->
          <div class="flex justify-center pt-2 sm:hidden" aria-hidden="true"><span class="h-1 w-9 rounded-full bg-line-strong" /></div>
          <div class="flex items-start gap-3 border-b border-line px-5 pt-3 pb-4 sm:pt-4">
            <div class="min-w-0 flex-1">
              <h2 class="text-[16px] font-semibold">{{ title }}</h2>
              <p v-if="description" class="mt-1 text-[14px] text-ink-2">{{ description }}</p>
            </div>
            <button
              type="button"
              class="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink"
              aria-label="Close"
              @click="emit('close')"
            >
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <div v-if="$slots.default" class="dialog-body px-5 py-4"><slot /></div>
          <div v-if="$slots.footer" class="dialog-footer flex flex-col-reverse gap-2 border-t border-line bg-canvas/60 px-5 py-3 sm:flex-row sm:justify-end">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
