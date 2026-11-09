<script setup lang="ts">
import { IonContent, IonInput, IonPage } from '@ionic/vue';
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, errorMessage } from '@/lib/api';

const route = useRoute();
const router = useRouter();
const email = ref(typeof route.query.email === 'string' ? route.query.email : '');
const busy = ref(false);
const error = ref<string | null>(null);
/** The address the link was requested for; the server answers the same for every address. */
const sentTo = ref<string | null>(null);

async function submit() {
  if (busy.value) return;
  const value = email.value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    error.value = 'Enter your work email.';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await api.post('/auth/forgot-password', { email: value });
    sentTo.value = value;
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
        <header class="sign-in-header"><BrandMark :size="32" /></header>
        <main class="sign-in-main" aria-labelledby="forgot-title">
          <div class="sign-in-content">
            <div v-if="sentTo" class="rise" role="status">
              <h1 id="forgot-title" class="sign-in-title">Check your email</h1>
              <p class="mt-3 text-[14px] leading-relaxed text-ink-2">
                If <strong class="font-medium text-ink">{{ sentTo }}</strong> has an account, a link to choose a new password is on its way. It works
                once and expires in 7 days.
              </p>
              <p class="mt-3 text-[13px] leading-relaxed text-ink-3">Nothing after a few minutes? Check Spam, or ask your administrator to send you a link from Users.</p>
              <UiButton class="sign-in-submit mt-7" variant="primary" size="lg" block @click="router.replace('/login')">Back to sign in</UiButton>
              <button type="button" class="mt-3 w-full text-center text-[13px] text-ink-2 hover:text-accent" @click="sentTo = null">Use a different email</button>
            </div>

            <template v-else>
              <div class="sign-in-heading rise">
                <h1 id="forgot-title" class="sign-in-title">Forgot your password?</h1>
                <p>Enter your work email and we’ll send you a link to choose a new one.</p>
              </div>
              <form class="sign-in-form" novalidate :aria-busy="busy" @submit.prevent="submit">
                <UiField v-slot="{ id, labelledby }" label="Work email">
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="email" class="field-input" type="email" autocomplete="username" inputmode="email" autocapitalize="none" :spellcheck="false" placeholder="name@organization.com" required :aria-describedby="error ? 'forgot-error' : undefined" />
                </UiField>
                <p v-if="error" id="forgot-error" class="sign-in-error" role="alert">{{ error }}</p>
                <UiButton class="sign-in-submit" type="submit" variant="primary" size="lg" block :loading="busy">{{ busy ? 'Sending…' : 'Send reset link' }}</UiButton>
              </form>
              <button type="button" class="mt-5 text-[13px] text-ink-2 hover:text-accent" @click="router.replace('/login')">← Back to sign in</button>
            </template>
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
.sign-in-title { font-size: 28px; font-weight: 550; line-height: 1.25; letter-spacing: -.035em; }
.sign-in-heading > p { margin-top: 10px; font-size: 14px; line-height: 1.7; color: var(--color-ink-2); }
.sign-in-form { display: flex; flex-direction: column; gap: 18px; margin-top: 28px; }
.sign-in-form :deep(label) { font-size: 13px; font-weight: 500; }
.sign-in-form .field-input { height: 48px; font-size: 14px; border-color: #d7dedd; background: white; border-radius: 7px; padding-inline: 13px; }
.sign-in-submit { height: 46px; margin-top: 4px; border-radius: 7px; font-size: 14px; }
.sign-in-error { border: 1px solid #b4231820; background: var(--color-bad-soft); padding: 11px 13px; border-radius: 10px; color: var(--color-bad); font-size: 13px; line-height: 1.6; }
.sign-in-footer { padding: 24px; text-align: center; color: var(--color-ink-3); font-size: 12px; }
@media (max-width: 639px) {
  .sign-in-header { padding: max(24px, env(safe-area-inset-top)) 24px 24px; }
  .sign-in-main { padding: 32px 24px 48px; }
  .sign-in-form .field-input { font-size: 16px; }
}
</style>
