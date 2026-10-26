import { onMounted, ref, shallowRef, watch, type WatchSource } from 'vue';
import { errorMessage } from './api';

/** Loads data for a page, tracking loading and error state. Re-runs when `deps` change. */
export function useAsync<T>(load: () => Promise<T>, deps: WatchSource[] = []) {
  const data = shallowRef<T | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);

  async function run(silent = false) {
    if (!silent) loading.value = true;
    error.value = null;
    try {
      data.value = await load();
    } catch (err) {
      error.value = errorMessage(err);
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => void run());
  if (deps.length) watch(deps, () => void run());
  return { data, loading, error, reload: run };
}
