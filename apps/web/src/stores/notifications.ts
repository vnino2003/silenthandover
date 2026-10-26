import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/lib/api';
import type { NotificationItem } from '@/lib/types';

export const useNotifications = defineStore('notifications', () => {
  const items = ref<NotificationItem[]>([]);
  const unread = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api.get<{ items: NotificationItem[]; unread: number }>('/notifications');
      items.value = res.items;
      unread.value = res.unread;
    } catch {
      /* keep the last known state; the next poll will retry */
    }
  }

  async function markRead(ids: string[] | null) {
    await api.post('/notifications/read', { ids });
    await refresh();
  }

  function start() {
    stop();
    void refresh();
    timer = setInterval(() => void refresh(), 20_000);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { items, unread, refresh, markRead, start, stop };
});
