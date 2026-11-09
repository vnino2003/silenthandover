import { ref } from 'vue';
import type { Router } from 'vue-router';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { StatusBar, Style } from '@capacitor/status-bar';

/** True inside the installed Android app, false in a browser. */
export const isNative = Capacitor.isNativePlatform();

/** Whether the device has a connection (browser and app). Pages show a notice when it drops. */
export const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);

/**
 * Device integration, the same app on web and Android:
 *  - connection status (web events or the Network plugin);
 *  - Android: status bar colour, and the hardware back button. Ionic closes an open dialog or menu
 *    first; otherwise the app goes back a page, and leaves the app only from a start page.
 */
export async function initDevice(router: Router) {
  try {
    online.value = (await Network.getStatus()).connected;
    await Network.addListener('networkStatusChange', (s) => (online.value = s.connected));
  } catch {
    window.addEventListener('online', () => (online.value = true));
    window.addEventListener('offline', () => (online.value = false));
  }
  if (!isNative) return;

  try {
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: '#ffffff' });
  } catch {
    /* status bar styling is cosmetic */
  }

  const startPages = new Set(['/', '/manager', '/manager/shifts', '/admin', '/admin/users', '/login']);
  document.addEventListener('ionBackButton', (ev) => {
    (ev as CustomEvent<{ register: (priority: number, handler: () => void) => void }>).detail.register(-1, () => {
      if (startPages.has(router.currentRoute.value.path) || window.history.length <= 1) void App.exitApp();
      else router.back();
    });
  });
}
