<script setup lang="ts">
import { IonContent, IonInput, IonInputPasswordToggle, IonPage } from '@ionic/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

const auth = useAuth();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref<string | null>(route.query.expired ? 'Your session expired. Please sign in again.' : null);

async function submit() {
  if (busy.value) return;
  if (!email.value.trim() || !password.value) {
    error.value = 'Enter your email and password';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await auth.signIn(email.value.trim(), password.value);
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : auth.homePath;
    await router.replace(next);
    const firstName = auth.profile?.full_name.trim().split(/\s+/)[0];
    toast.ok(firstName ? `Welcome back, ${firstName}!` : 'Welcome back!');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <IonPage>
    <IonContent>
        <div class="sign-in-page">
          <a href="#sign-in-form" class="skip-link">Skip to sign in</a>
          <header class="sign-in-header"><BrandMark :size="32" /></header>
          <main class="sign-in-main" aria-labelledby="sign-in-title">
              <div class="sign-in-content">
                <div class="sign-in-heading">
                  <h1 id="sign-in-title">Sign in</h1>
                  <p>Enter your work account details to continue.</p>
                </div>

                <form id="sign-in-form" class="sign-in-form" tabindex="-1" novalidate :aria-busy="busy" @submit.prevent="submit">
                  <UiField v-slot="{ id, labelledby }" label="Work email">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="email" class="field-input" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" :spellcheck="false" placeholder="name@organization.com" required :aria-describedby="error ? 'sign-in-error' : undefined"  />
                  </UiField>
                  <UiField v-slot="{ id, labelledby }" label="Password">
                    <div class="password-field">
                      <IonInput :id="id" :aria-labelledby="labelledby" v-model="password" class="field-input" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required :aria-describedby="error ? 'sign-in-error' : undefined"><IonInputPasswordToggle slot="end" color="medium" /></IonInput>
                    </div>
                  </UiField>
                  <RouterLink :to="{ path: '/forgot-password', query: email.trim() ? { email: email.trim() } : {} }" class="forgot-link">Forgot password?</RouterLink>
                  <p v-if="error" id="sign-in-error" class="sign-in-error" role="alert">{{ error }}</p>
                  <UiButton class="sign-in-submit" type="submit" variant="primary" size="lg" block :loading="busy">
                    {{ busy ? 'Signing in…' : 'Sign in' }}
                  </UiButton>
                </form>

                <details class="sign-in-help">
                  <summary>Need help signing in?<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></summary>
                  <p>Use the account provided by your organization. New accounts get an invitation email. If you’ve forgotten your password, use “Forgot password?” to get a reset link by email; for anything else, contact your administrator.</p>
                </details>
              </div>
          </main>
          <footer class="sign-in-footer">Accounts are managed by your organization.</footer>
        </div>
    </IonContent>
  </IonPage>
</template>

<style scoped>
.sign-in-page { min-height: 100dvh; display: flex; flex-direction: column; background: #fcfdfc; }
.sign-in-header { padding: 32px 40px; font-size: 15px; font-weight: 550; letter-spacing: -.3px; }
.sign-in-main { display: flex; flex: 1; align-items: center; justify-content: center; padding: 40px 24px 80px; }
.sign-in-content { width: 100%; max-width: 360px; }
.sign-in-heading h1 { font-size: 28px; font-weight: 550; line-height: 1.25; letter-spacing: -.035em; }
.sign-in-heading > p { margin-top: 10px; font-size: 14px; line-height: 1.7; color: var(--color-ink-2); }
.sign-in-form { display: flex; flex-direction: column; gap: 20px; margin-top: 30px; scroll-margin-top: 24px; }
.sign-in-form :deep(label) { font-size: 13px; font-weight: 500; }
.sign-in-form .field-input { height: 48px; font-size: 14px; border-color: #d7dedd; background: white; border-radius: 7px; padding-inline: 13px; }
.sign-in-form .field-input::placeholder { color: var(--color-ink-3); }
.sign-in-form .field-input:focus { border-color: var(--color-accent); background: white; }
.password-field { position: relative; }
.password-field .field-input { padding-right: 68px; }
.password-toggle { position: absolute; top: 4px; right: 4px; bottom: 4px; min-width: 54px; padding: 0 10px; border-radius: 7px; color: var(--color-ink-2); font-size: 12px; font-weight: 500; }
.password-toggle:hover { color: var(--color-accent-ink); background: var(--color-accent-soft); }
.sign-in-submit { height: 46px; margin-top: 4px; border-radius: 7px; font-size: 14px; }
.forgot-link { align-self: flex-end; margin-top: -10px; color: var(--color-accent-ink); font-size: 13px; font-weight: 500; border-radius: 4px; }
.forgot-link:hover { text-decoration: underline; }
.sign-in-error { border: 1px solid #b4231820; background: var(--color-bad-soft); padding: 11px 13px; border-radius: 10px; color: var(--color-bad); font-size: 13px; line-height: 1.6; }
.sign-in-help { margin-top: 18px; }
.sign-in-help summary { display: inline-flex; min-height: 44px; align-items: center; gap: 6px; color: var(--color-ink-2); font-size: 13px; list-style: none; border-radius: 5px; }
.sign-in-help summary::-webkit-details-marker { display: none; }
.sign-in-help summary:hover { color: var(--color-accent); }
.sign-in-help svg { width: 14px; height: 14px; transition: transform 180ms ease; }
.sign-in-help[open] svg { transform: rotate(180deg); }
.sign-in-help p { padding-top: 4px; color: var(--color-ink-2); font-size: 13px; line-height: 1.8; }
.sign-in-footer { padding: 24px; text-align: center; color: var(--color-ink-3); font-size: 12px; }
@media (max-width: 639px) {
  .sign-in-header { padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) 24px max(24px, env(safe-area-inset-left)); }
  .sign-in-main { padding: 32px max(24px, env(safe-area-inset-right)) 48px max(24px, env(safe-area-inset-left)); }
  .sign-in-form .field-input { font-size: 16px; }
  .sign-in-footer { padding-bottom: max(24px, env(safe-area-inset-bottom)); }
}
@media (max-height: 650px) {
  .sign-in-header { padding-block: 20px; }
  .sign-in-main { padding-block: 20px; }
}
</style>
