<script setup lang="ts">
import { IonContent, IonInput, IonInputPasswordToggle, IonPage } from '@ionic/vue';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Invitation {
  full_name: string;
  email: string;
  role: string;
  department_name: string | null;
  purpose: 'invite' | 'reset';
  expires_at: string;
}

const auth = useAuth();
const toast = useToast();
const router = useRouter();

// The token arrives in the #fragment so it is never sent to a server log or in a Referer.
// It is read once and removed from the address bar.
const token = ref('');
const invitation = ref<Invitation | null>(null);
const linkError = ref<string | null>(null);
const checking = ref(true);

const password = ref('');
const confirm = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  token.value = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  if (window.location.hash) history.replaceState(history.state, '', window.location.pathname);
  if (!token.value) {
    linkError.value = 'This page opens from the link in your invitation email. Open that email and use its link.';
    checking.value = false;
    return;
  }
  try {
    invitation.value = await api.post<Invitation>('/invitations/check', { token: token.value });
  } catch (err) {
    linkError.value = errorMessage(err);
  } finally {
    checking.value = false;
  }
});

const firstName = computed(() => invitation.value?.full_name.trim().split(/\s+/)[0] ?? '');
const isReset = computed(() => invitation.value?.purpose === 'reset');
const checks = computed(() => [
  { ok: password.value.length >= 10, label: 'At least 10 characters' },
  { ok: !!password.value && password.value === confirm.value, label: 'Both entries match' },
]);

async function submit() {
  if (busy.value || !invitation.value) return;
  if (password.value.length < 10) {
    error.value = 'Use at least 10 characters.';
    return;
  }
  if (password.value !== confirm.value) {
    error.value = 'The two passwords do not match.';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    const r = await api.post<{ email: string; session: { token: string; expires_at: string } | null }>('/invitations/accept', {
      token: token.value,
      password: password.value,
    });
    await auth.adoptSession(r.email, password.value, r.session);
    await router.replace(auth.homePath);
    toast.ok(isReset.value ? 'Password changed. You are signed in.' : `Welcome, ${firstName.value}! Your account is ready.`);
  } catch (err) {
    // A used or expired link cannot be retried; anything else (a network blip) can.
    if (err instanceof ApiError && (err.status === 410 || err.status === 404 || err.status === 403)) {
      linkError.value = err.message;
      invitation.value = null;
    } else {
      error.value = errorMessage(err);
    }
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
          <main class="sign-in-main" aria-labelledby="set-password-title">
            <div class="sign-in-content">
              <div v-if="checking" class="space-y-3" aria-busy="true" aria-label="Checking your link">
                <div class="skeleton h-8 w-48" />
                <div class="skeleton h-4 w-64" />
                <div class="skeleton mt-8 h-12 w-full" />
                <div class="skeleton h-12 w-full" />
              </div>

              <div v-else-if="linkError" class="rise">
                <h1 id="set-password-title" class="sign-in-title">This link can’t be used</h1>
                <p class="sign-in-error mt-5" role="alert">{{ linkError }}</p>
                <UiButton class="sign-in-submit mt-6" variant="primary" size="lg" block @click="router.replace('/forgot-password')">Send me a new link</UiButton>
                <UiButton class="mt-2" variant="ghost" block @click="router.replace('/login')">Go to sign in</UiButton>
              </div>

              <template v-else-if="invitation">
                <div class="sign-in-heading rise">
                  <h1 id="set-password-title" class="sign-in-title">{{ isReset ? 'Choose a new password' : `Welcome, ${firstName}` }}</h1>
                  <p v-if="isReset">Set a new password for your account. Your old one stops working once you save.</p>
                  <p v-else>
                    You’ve been added as <strong class="font-medium text-ink">{{ invitation.role }}</strong><template v-if="invitation.department_name"> in {{ invitation.department_name }}</template>. Choose a password to finish setting up your account.
                  </p>
                </div>

                <form class="sign-in-form" novalidate :aria-busy="busy" @submit.prevent="submit">
                  <UiField v-slot="{ id, labelledby }" label="Work email">
                    <IonInput :id="id" :aria-labelledby="labelledby" :value="invitation.email" class="field-input" type="email" autocomplete="username" readonly  />
                  </UiField>
                  <UiField v-slot="{ id, labelledby }" label="New password">
                    <div class="password-field">
                      <IonInput :id="id" :aria-labelledby="labelledby" v-model="password" class="field-input" type="password" autocomplete="new-password" placeholder="At least 10 characters" required :minlength="10" :maxlength="200"><IonInputPasswordToggle slot="end" color="medium" /></IonInput>
                    </div>
                  </UiField>
                  <UiField v-slot="{ id, labelledby }" label="Confirm password">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="confirm" class="field-input" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" placeholder="Type it again" required :maxlength="200"  />
                  </UiField>
                  <ul class="checks" aria-label="Password requirements">
                    <li v-for="c in checks" :key="c.label" :class="{ ok: c.ok }">
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path v-if="c.ok" d="m4 8.5 2.5 2.5L12 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /><circle v-else cx="8" cy="8" r="2" fill="currentColor" /></svg>
                      {{ c.label }}<span class="sr-only">{{ c.ok ? ' — done' : ' — not yet' }}</span>
                    </li>
                  </ul>
                  <p v-if="error" class="sign-in-error" role="alert">{{ error }}</p>
                  <UiButton class="sign-in-submit" type="submit" variant="primary" size="lg" block :loading="busy">
                    {{ busy ? 'Saving…' : isReset ? 'Save new password' : 'Set password and sign in' }}
                  </UiButton>
                </form>
                <p class="mt-5 text-[12.5px] leading-relaxed text-ink-3">This link works once. Don’t share it — anyone with it could set your password.</p>
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
.sign-in-content { width: 100%; max-width: 380px; }
.sign-in-title { font-size: 28px; font-weight: 550; line-height: 1.25; letter-spacing: -.035em; }
.sign-in-heading > p { margin-top: 10px; font-size: 14px; line-height: 1.7; color: var(--color-ink-2); }
.sign-in-form { display: flex; flex-direction: column; gap: 18px; margin-top: 28px; }
.sign-in-form :deep(label) { font-size: 13px; font-weight: 500; }
.sign-in-form .field-input { height: 48px; font-size: 14px; border-color: #d7dedd; background: white; border-radius: 7px; padding-inline: 13px; }
.sign-in-form .field-input[readonly] { background: var(--color-canvas); color: var(--color-ink-2); }
.sign-in-form .field-input::placeholder { color: var(--color-ink-3); }
.sign-in-form .field-input:focus { border-color: var(--color-accent); background: white; }
.password-field { position: relative; }
.password-field .field-input { padding-right: 68px; }
.password-toggle { position: absolute; top: 4px; right: 4px; bottom: 4px; min-width: 54px; padding: 0 10px; border-radius: 7px; color: var(--color-ink-2); font-size: 12px; font-weight: 500; }
.password-toggle:hover { color: var(--color-accent-ink); background: var(--color-accent-soft); }
.checks { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: -6px; font-size: 12.5px; color: var(--color-ink-3); }
.checks li { display: inline-flex; align-items: center; gap: 5px; transition: color 160ms ease; }
.checks li.ok { color: var(--color-ok); }
.checks svg { width: 14px; height: 14px; }
.sign-in-submit { height: 46px; margin-top: 4px; border-radius: 7px; font-size: 14px; }
.sign-in-error { border: 1px solid #b4231820; background: var(--color-bad-soft); padding: 11px 13px; border-radius: 10px; color: var(--color-bad); font-size: 13px; line-height: 1.6; }
.sign-in-footer { padding: 24px; text-align: center; color: var(--color-ink-3); font-size: 12px; }
@media (max-width: 639px) {
  .sign-in-header { padding: max(24px, env(safe-area-inset-top)) 24px 24px; }
  .sign-in-main { padding: 32px 24px 48px; }
  .sign-in-form .field-input { font-size: 16px; }
}
</style>
