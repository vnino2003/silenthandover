import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

export const useToast = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let n = 0;
  const lifetime = (tone: Toast['tone']) => (tone === 'bad' ? 7000 : 4000);

  function schedule(id: number, ms: number) {
    timers.set(id, setTimeout(() => dismiss(id), ms));
  }
  function push(text: string, tone: Toast['tone'] = 'ok') {
    // The same message twice in a row (a double click) shows once.
    if (toasts.value.at(-1)?.text === text) return;
    const id = ++n;
    toasts.value.push({ id, tone, text });
    if (toasts.value.length > 3) dismiss(toasts.value[0]!.id);
    schedule(id, lifetime(tone));
  }
  function dismiss(id: number) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }
  /** Hovering a toast keeps it open so it can be read; leaving gives it a moment more. */
  function hold(id: number) {
    clearTimeout(timers.get(id));
  }
  function release(id: number) {
    if (toasts.value.some((t) => t.id === id)) schedule(id, 2000);
  }
  return {
    toasts,
    push,
    dismiss,
    hold,
    release,
    ok: (t: string) => push(t, 'ok'),
    error: (t: string) => push(t, 'bad'),
    info: (t: string) => push(t, 'info'),
  };
});
