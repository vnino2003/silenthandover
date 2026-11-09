import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { IonicVue } from '@ionic/vue';
// Ionic's required base styles. Its optional normalize/typography sheets are left out: the
// existing typography (Inter, sizes, colours) stays the single source of the look.
import '@ionic/vue/css/core.css';
import '@ionic/vue/css/structure.css';
import App from './App.vue';
import { router } from './router';
import { useAuth } from './stores/auth';
import { initDevice } from './lib/native';
import './style.css';
import './theme/ionic.css';

// One look on every device ('md'). Page and modal animations stay off: the app's own CSS motion
// is used instead, and it never stalls when the browser tab is in the background.
const app = createApp(App).use(IonicVue, { mode: 'md', animated: false }).use(createPinia()).use(router);
// `$terms` in any template: the signed-in department's own words (Head Nurse, shift endorsement, concern).
Object.defineProperty(app.config.globalProperties, '$terms', { get: () => useAuth().terms });
router.isReady().then(() => {
  app.mount('#app');
  void initDevice(router);
});
