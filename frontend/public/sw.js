/* Silent Handover service worker: shows phone and desktop alerts (Web Push) and opens the app on tap.
 * It caches nothing; the app always loads from the server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = {};
  }
  const title = msg.title || 'Silent Handover';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: msg.body || '',
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: msg.id || undefined,
      data: { link: typeof msg.link === 'string' && msg.link.startsWith('/') ? msg.link : '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.link) || '/notifications', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ('navigate' in w) await w.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
