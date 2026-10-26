import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

export const useToast = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  let n = 0;
  function push(text: string, tone: Toast['tone'] = 'ok') {
    const id = ++n;
    toasts.value.push({ id, tone, text });
    setTimeout(() => dismiss(id), tone === 'bad' ? 7000 : 4000);
  }
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  return { toasts, push, dismiss, ok: (t: string) => push(t, 'ok'), error: (t: string) => push(t, 'bad'), info: (t: string) => push(t, 'info') };
});
