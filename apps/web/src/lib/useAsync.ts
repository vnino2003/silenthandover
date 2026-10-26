import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type WatchSource } from 'vue';
import { errorMessage } from './api';

/**
 * Loads data for a page, tracking loading and error state. Re-runs when `deps` change.
 *
 * `loading` is only true for the first load: later loads (a new filter, week or tab) keep the
 * current data on screen and set `refreshing` instead, so the page doesn't flash a skeleton.
 * `refreshMs` quietly reloads on an interval and whenever the browser tab regains focus.
 */
export function useAsync<T>(load: () => Promise<T>, deps: WatchSource[] = [], opts: { refreshMs?: number } = {}) {
  const data = shallowRef<T | null>(null);
  const loading = ref(true);
  const refreshing = ref(false);
  const error = ref<string | null>(null);
  let seq = 0;

  async function run(silent = false) {
    const mine = ++seq;
    if (data.value === null && !silent) loading.value = true;
    else if (!silent) refreshing.value = true;
    try {
      const result = await load();
      if (mine !== seq) return; // a newer request has started; its answer wins
      data.value = result;
      error.value = null;
    } catch (err) {
      // A failed background refresh keeps what is on screen; a failed visible load says why.
      if (mine === seq && !(silent && data.value !== null)) error.value = errorMessage(err);
    } finally {
      if (mine === seq) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const onFocus = () => document.visibilityState === 'visible' && void run(true);
  onMounted(() => {
    void run();
    if (opts.refreshMs) {
      timer = setInterval(() => document.visibilityState === 'visible' && void run(true), opts.refreshMs);
      document.addEventListener('visibilitychange', onFocus);
    }
  });
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
    document.removeEventListener('visibilitychange', onFocus);
  });
  if (deps.length) watch(deps, () => void run());
  return { data, loading, refreshing, error, reload: run };
}
