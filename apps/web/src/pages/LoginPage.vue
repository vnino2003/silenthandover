<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ROLE_LABELS, type Role } from '@sh/shared';
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
const busy = ref(false);
const error = ref<string | null>(route.query.expired ? 'Your session expired. Please sign in again.' : null);
const demo = computed(() => auth.config?.demo ?? null);

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

function useAccount(a: { email: string }) {
  email.value = a.email;
  password.value = demo.value?.password ?? '';
  void submit();
}
</script>

<template>
  <div class="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
    <section class="flex flex-col justify-between px-6 py-8 sm:px-12 lg:py-12">
      <p class="text-[15px] font-semibold tracking-[-0.01em]"><BrandMark :size="34" /></p>

      <div class="mx-auto w-full max-w-sm py-12">
        <h1 class="text-[26px] leading-tight font-semibold tracking-[-0.015em]">Sign in</h1>
        <p class="mt-2 text-[14px] text-ink-2">End-of-shift reports, verified handovers and open issues for your team.</p>

        <form class="mt-8 space-y-4" novalidate @submit.prevent="submit">
          <UiField v-slot="{ id }" label="Work email">
            <input :id="id" v-model="email" class="field-input" type="email" autocomplete="username" inputmode="email" />
          </UiField>
          <UiField v-slot="{ id }" label="Password">
            <input :id="id" v-model="password" class="field-input" type="password" autocomplete="current-password" />
          </UiField>
          <p v-if="error" class="rounded-md bg-bad-soft px-3 py-2 text-[14px] text-bad" role="alert">{{ error }}</p>
          <UiButton type="submit" variant="primary" size="lg" block :loading="busy">Sign in</UiButton>
        </form>

        <div v-if="demo" class="mt-10">
          <div class="flex items-baseline justify-between">
            <p class="eyebrow">Demo accounts</p>
            <p class="text-[12px] text-ink-3">Synthetic data · local only</p>
          </div>
          <ul class="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            <li v-for="a in demo.accounts" :key="a.email">
              <button
                class="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-sunken disabled:opacity-60"
                :disabled="busy"
                @click="useAccount(a)"
              >
                <span class="min-w-0">
                  <span class="block truncate text-[14px] font-medium">{{ a.full_name }}</span>
                  <span class="block truncate text-[12.5px] text-ink-3">{{ a.email }}</span>
                </span>
                <span class="shrink-0 text-[12.5px] text-ink-2">{{ ROLE_LABELS[a.role as Role] }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <p class="text-[12.5px] text-ink-3">AI-assisted drafts are always verified by a supervisor before anyone receives them.</p>
    </section>

    <aside class="hidden border-l border-line bg-surface lg:flex lg:flex-col lg:justify-center lg:px-16">
      <div class="max-w-md">
        <p class="eyebrow">How a handover moves</p>
        <ol class="mt-6 space-y-6">
          <li v-for="(step, i) in [
            ['Report', 'You submit your end-of-shift report during the reporting window.'],
            ['Sanitize', 'Names, contact details and medical information are removed before analysis.'],
            ['Draft', 'A structured draft is prepared and checked against your own words.'],
            ['Verify', 'Your supervisor compares every claim with the original and approves it.'],
            ['Deliver', 'The incoming shift receives the approved handover and acknowledges it.'],
          ]" :key="step[0]" class="flex gap-4">
            <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[12px] font-medium text-ink-2 tnum">{{ i + 1 }}</span>
            <div>
              <p class="text-[15px] font-medium">{{ step[0] }}</p>
              <p class="mt-0.5 text-[14px] text-ink-2">{{ step[1] }}</p>
            </div>
          </li>
        </ol>
      </div>
    </aside>
  </div>
</template>
