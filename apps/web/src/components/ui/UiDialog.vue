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
      panel.value?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button')?.focus();
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
    <Transition name="fade">
      <div v-if="open" class="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-0 sm:items-center sm:p-6" @mousedown.self="emit('close')">
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-surface shadow-pop sm:rounded-lg"
          :class="wide ? 'sm:max-w-2xl' : 'sm:max-w-md'"
        >
          <div class="border-b border-line px-5 py-4">
            <h2 class="text-[16px] font-semibold">{{ title }}</h2>
            <p v-if="description" class="mt-1 text-[14px] text-ink-2">{{ description }}</p>
          </div>
          <div class="px-5 py-4"><slot /></div>
          <div v-if="$slots.footer" class="flex flex-col-reverse gap-2 border-t border-line bg-canvas/60 px-5 py-3 sm:flex-row sm:justify-end">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
