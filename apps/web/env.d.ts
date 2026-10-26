/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API when it is not served from the same origin (production). */
  readonly VITE_API_URL?: string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
