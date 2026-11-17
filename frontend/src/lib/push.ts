import { ref } from 'vue';
import { api } from './api';
import { isNative } from './native';

/**
 * Phone and desktop alerts (Web Push) and installing the web app.
 *
 * Works in Chrome, Edge and Firefox (desktop and Android) and, on iPhone, in the app added to the
 * Home Screen. The Android app built with Capacitor does not show them: its WebView has no push.
 * Alerts are per device and per person: signing out turns them off on that device.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const hasWindow = typeof window !== 'undefined';
export const pushSupported =
  !isNative && hasWindow && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone and iPad only allow alerts for the app added to the Home Screen. */
export const isIos = hasWindow && /iPad|iPhone|iPod/.test(navigator.userAgent);
export const runningInstalled = ref(
  hasWindow && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true),
);

/** The browser's "Install app" offer, when it makes one (Chrome and Edge). */
export const installOffer = ref<BeforeInstallPromptEvent | null>(null);
if (hasWindow && !isNative) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installOffer.value = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    installOffer.value = null;
    runningInstalled.value = true;
  });
}

export async function installApp(): Promise<boolean> {
  const offer = installOffer.value;
  if (!offer) return false;
  await offer.prompt();
  const { outcome } = await offer.userChoice;
  installOffer.value = null;
  return outcome === 'accepted';
}

export async function registerServiceWorker(): Promise<void> {
  if (!pushSupported) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    /* alerts stay off; the app works without them */
  }
}

/** 'on' when this device is subscribed and allowed, 'blocked' when the person denied permission. */
export type PushState = 'unsupported' | 'off' | 'on' | 'blocked';
export const pushState = ref<PushState>(pushSupported ? 'off' : 'unsupported');

function keyBytes(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : isIos ? 'iPhone or iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${runningInstalled.value ? 'Installed app' : browser} on ${os}`;
}

async function subscription(): Promise<PushSubscription | null> {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function save(sub: PushSubscription) {
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.put('/me/push', { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, device_label: deviceLabel() });
}

/** Reads this device's state, and re-sends an existing subscription so the server has it for this person. */
export async function syncPush(): Promise<PushState> {
  if (!pushSupported) return (pushState.value = 'unsupported');
  if (Notification.permission === 'denied') return (pushState.value = 'blocked');
  try {
    const sub = await subscription();
    if (sub && Notification.permission === 'granted') {
      await save(sub);
      return (pushState.value = 'on');
    }
  } catch {
    /* treat as off */
  }
  return (pushState.value = 'off');
}

/** Asks for permission and subscribes this device. Must run from a tap or click. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported) return (pushState.value = 'unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return (pushState.value = permission === 'denied' ? 'blocked' : 'off');
  const { available, public_key } = await api.get<{ available: boolean; public_key: string | null }>('/me/push');
  if (!available || !public_key) throw new Error('Phone alerts are not available on this server.');
  await registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = keyBytes(public_key);
  if (sub) {
    // A subscription made for a different server key cannot receive this server's alerts.
    const current = sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (!current || current.length !== key.length || current.some((b, i) => b !== key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  await save(sub);
  return (pushState.value = 'on');
}

export async function disablePush(): Promise<PushState> {
  const sub = await subscription().catch(() => null);
  if (sub) {
    await api.del('/me/push', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return (pushState.value = pushSupported ? (Notification.permission === 'denied' ? 'blocked' : 'off') : 'unsupported');
}

export async function sendTestAlert(): Promise<void> {
  await api.post('/me/push/test');
}
