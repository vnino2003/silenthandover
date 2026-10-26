import { onMounted, onUnmounted, ref } from 'vue';
import { useAuth } from '@/stores/auth';

/** Server-adjusted current time, refreshed on an interval. For display only. */
export function useNow(intervalMs = 15_000) {
  const auth = useAuth();
  const now = ref(auth.serverNow());
  let t: ReturnType<typeof setInterval> | null = null;
  onMounted(() => {
    t = setInterval(() => (now.value = auth.serverNow()), intervalMs);
  });
  onUnmounted(() => {
    if (t) clearInterval(t);
  });
  return now;
}
