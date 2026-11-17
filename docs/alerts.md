# Install and alerts (Web Push)

Anyone can install Silent Handover from the browser and get alerts on that device, whatever their role.

## For people using the app

1. Open Silent Handover in **Chrome or Edge** (Android, Windows, Mac) or **Firefox**, and sign in.
2. To install it: choose **Install app** on the Notifications or Profile page (or the browser's own install
   option). On **iPhone or iPad**, tap **Share → Add to Home Screen** and open it from the Home Screen.
3. On **Notifications** or **Profile**, choose **Turn on alerts** and allow notifications.
   **Send a test** on Profile checks it.

From then on every notification in the app also arrives on that device, even when the app is closed:

| Who | Examples |
|---|---|
| Head Nurse | endorsement waiting for approval, leave request, understaffed shift, missing endorsement, new concern, concern marked done to confirm |
| Staff nurse | new or changed shift, shift reminder, leave approved or not approved, endorsement approved / revision requested / rejected, incoming endorsement to acknowledge, endorsement acknowledged, concern assigned or confirmed, DTR certified, payslip released |
| IT administrator | AI processing or email delivery failures, leave request with no approver |
| Anyone given a duty | new access (HR timekeeper, payroll, finance, Nursing Service) |

Alerts show the notification's title and short text only. Endorsement content is never in them.
Signing out turns alerts off on that device; another person signing in on it gets their own alerts only
after turning them on. **Turn off** on Profile stops them for that device.

## How it works

- The browser subscribes with the server's public key (VAPID, created once and stored encrypted with
  `SECRETS_ENCRYPTION_KEY`; local mode creates that key itself). Subscriptions are in
  `public.push_subscriptions`, readable only by their owner.
- A trigger on `public.notifications` queues each new notification for the recipient's devices
  (`internal.push_queue`). The API sends the queue right after the request that created it, and on every
  background pass. Messages are encrypted for the device (RFC 8291, aes128gcm), so the push service
  (Google, Mozilla, Apple) only sees ciphertext. Busy services are retried with backoff; devices the
  service reports gone (404/410) are removed.
- `public/sw.js` shows the alert and opens the linked page when it is tapped. It caches nothing.

## Requirements and limits

- HTTPS (or `localhost` for development). The API must reach the push services over the internet.
- Supabase mode needs `SECRETS_ENCRYPTION_KEY`; without it the Profile page says alerts are unavailable.
- The Capacitor Android APK (`docs/android.md`) has no push: its WebView cannot subscribe. On Android,
  install from Chrome to get alerts. Native push in the APK would need Firebase Cloud Messaging.
- iPhone and iPad show alerts only for the app added to the Home Screen (iOS 16.4 or later).
