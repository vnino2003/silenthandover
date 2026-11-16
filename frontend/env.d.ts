/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API when it is not served from the same origin (production). */
  readonly VITE_API_URL?: string;
  /** Public download link of the Android APK shown on the sign-in page (default: the GitHub release). */
  readonly VITE_ANDROID_APK_URL?: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
