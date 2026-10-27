<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandMark from '@/components/BrandMark.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/stores/auth';

const auth = useAuth();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref<string | null>(route.query.expired ? 'Your session expired. Please sign in again.' : null);

async function submit() {
  if (!email.value || !password.value) {
    error.value = 'Enter your email and password';
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await auth.signIn(email.value.trim(), password.value);
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : auth.homePath;
    router.replace(next);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
    <main class="w-full max-w-[400px]">
      <div class="rise mb-8 flex justify-center">
        <BrandMark :size="40" />
      </div>

      <div class="rise rise-delay card px-6 py-7 shadow-pop sm:px-8">
        <h1 class="text-center text-[22px] leading-tight font-semibold tracking-[-0.015em]">Sign in</h1>
        <p class="mt-1.5 text-center text-[14px] text-ink-2">Shift reports, handovers and operational concerns for your team.</p>

        <form class="mt-7 space-y-4" novalidate @submit.prevent="submit">
          <UiField v-slot="{ id }" label="Work email">
            <input :id="id" v-model="email" class="field-input" type="email" autocomplete="username" inputmode="email" placeholder="name@company.com" />
          </UiField>
          <UiField v-slot="{ id }" label="Password">
            <div class="relative">
              <input :id="id" v-model="password" class="field-input pr-16" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" />
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-3 text-[12.5px] font-medium text-ink-3 hover:text-ink"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                {{ showPassword ? 'Hide' : 'Show' }}
              </button>
            </div>
          </UiField>
          <p v-if="error" class="rounded-md bg-bad-soft px-3 py-2 text-[14px] text-bad" role="alert">{{ error }}</p>
          <UiButton type="submit" variant="primary" size="lg" block :loading="busy">Sign in</UiButton>
        </form>
      </div>

      <p class="mt-6 text-center text-[12.5px] text-ink-3">Forgot your password? Ask your administrator to reset it.</p>
    </main>
  </div>
</template>
