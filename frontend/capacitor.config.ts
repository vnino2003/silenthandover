import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The installed Android app wraps the same built web app (dist/). It calls the API at the HTTPS
 * address baked in at build time (VITE_API_URL), so that API must allow the app's origin
 * https://localhost in CORS_ORIGINS. Invitation and password-reset links open in the browser
 * (APP_BASE_URL); after choosing a password, people sign in in the app.
 */
const config: CapacitorConfig = {
  appId: 'com.silenthandover.app',
  appName: 'Silent Handover',
  webDir: 'dist',
  android: {
    // Plain-HTTP API addresses are refused; the API must be HTTPS.
    allowMixedContent: false,
  },
  plugins: {
    StatusBar: { overlaysWebView: false, style: 'LIGHT', backgroundColor: '#ffffff' },
  },
};

export default config;
