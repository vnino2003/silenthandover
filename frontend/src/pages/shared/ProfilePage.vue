<script setup lang="ts">
import { IonCheckbox, IonContent, IonInput, IonPage } from '@ionic/vue';
import { ref } from 'vue';
import { ROLE_LABELS } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiField from '@/components/ui/UiField.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { tzLabel } from '@/lib/format';
import { prepareAvatar } from '@/lib/photo';
import type { Profile } from '@/lib/types';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

const auth = useAuth();
const toast = useToast();
const p = auth.profile!;
const form = ref({ notify_email: p.notify_email, notify_sms: p.notify_sms, phone: p.phone ?? '' });
const errors = ref<Record<string, string>>({});
const saving = ref(false);

const photoBusy = ref(false);
const photoError = ref<string | null>(null);
async function onPhoto(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  photoBusy.value = true;
  photoError.value = null;
  try {
    const photo = await prepareAvatar(file);
    auth.profile = await api.put<Profile>('/me/photo', { content_type: photo.content_type, data_base64: photo.data_base64 });
    toast.ok('Profile picture updated');
  } catch (err) {
    photoError.value = err instanceof Error && !(err instanceof ApiError) ? err.message : errorMessage(err);
  } finally {
    photoBusy.value = false;
  }
}
async function removePhoto() {
  photoBusy.value = true;
  try {
    auth.profile = await api.del<Profile>('/me/photo');
    toast.ok('Profile picture removed');
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    photoBusy.value = false;
  }
}

async function save() {
  saving.value = true;
  errors.value = {};
  try {
    auth.profile = await api.patch<Profile>('/me/preferences', { ...form.value, phone: form.value.phone.trim() || null });
    toast.ok('Preferences saved');
  } catch (err) {
    if (err instanceof ApiError) errors.value = err.fields;
    toast.error(errorMessage(err));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-2xl">
            <PageHeader title="Profile" />
            <section class="card mb-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center" aria-label="Profile picture">
              <UserAvatar :id="p.id" :name="p.full_name" :version="auth.profile?.photo_version" :size="88" />
              <div class="min-w-0 flex-1">
                <p class="text-[16px] font-semibold">{{ p.full_name }}</p>
                <p class="text-[13px] text-ink-3">Your picture is shown to your {{ $terms.head }} and your unit. JPEG, PNG or WebP — it’s cropped to a square.</p>
                <p v-if="photoError" class="mt-1 text-[13px] text-bad" role="alert">{{ photoError }}</p>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                  <label class="inline-flex cursor-pointer items-center rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13.5px] font-medium hover:bg-sunken" :class="{ 'pointer-events-none opacity-60': photoBusy }">
                    <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" :disabled="photoBusy" @change="onPhoto" />
                    {{ photoBusy ? 'Saving…' : auth.profile?.photo_version ? 'Change picture' : 'Upload picture' }}
                  </label>
                  <UiButton v-if="auth.profile?.photo_version" size="sm" variant="ghost" :disabled="photoBusy" @click="removePhoto">Remove</UiButton>
                </div>
              </div>
            </section>
            <section class="card p-5">
              <dl class="grid gap-4 text-[14px] sm:grid-cols-2">
                <div><dt class="text-ink-3">Name</dt><dd class="font-medium">{{ p.full_name }}</dd></div>
                <div><dt class="text-ink-3">Email</dt><dd>{{ p.email }}</dd></div>
                <div><dt class="text-ink-3">Role</dt><dd>{{ auth.roleLabel(p.role) }}</dd></div>
                <div>
                  <dt class="text-ink-3">Department</dt>
                  <dd>{{ p.department_name ?? '—' }}</dd>
                </div>
                <div v-if="p.department_timezone"><dt class="text-ink-3">Time zone</dt><dd>{{ p.department_timezone }} ({{ tzLabel(p.department_timezone) }})</dd></div>
                <div>
                  <dt class="text-ink-3">Pseudonym</dt>
                  <dd class="tnum">{{ p.pseudonym }} <span class="text-[12.5px] text-ink-3">— used instead of your name in AI processing</span></dd>
                </div>
              </dl>
              <p class="mt-4 text-[13px] text-ink-3">Name, role and department are managed by your administrator.</p>
            </section>

            <form class="card mt-5 space-y-4 p-5" @submit.prevent="save">
              <h2 class="text-[15px] font-semibold">Notifications</h2>
              <p class="text-[13px] text-ink-3">You always receive notifications in the app. Emails contain a link only, never endorsement content.</p>
              <IonCheckbox class="flex items-center gap-2 text-[14px]" v-model="form.notify_email" label-placement="end" justify="start">Email me</IonCheckbox>
              <IonCheckbox class="flex items-center gap-2 text-[14px]" :class="{ 'text-ink-3': !auth.config?.integrations.sms.connected }" v-model="form.notify_sms" :disabled="!auth.config?.integrations.sms.connected && !form.notify_sms" label-placement="end" justify="start">Text me (SMS)<StatusBadge v-if="!auth.config?.integrations.sms.connected" tone="neutral" label="Coming soon" /></IonCheckbox>
              <p v-if="form.notify_sms && !auth.config?.integrations.sms.connected" class="text-[13px] text-warn">
                Text messages are not set up yet, so none are sent. Your preference is saved for when they are.
              </p>
              <UiField v-slot="{ id, labelledby }" label="Mobile number" optional :error="errors.phone">
                <IonInput :id="id" :aria-labelledby="labelledby" v-model="form.phone" class="field-input max-w-xs" type="tel" autocomplete="tel" placeholder="+63 9xx xxx xxxx"  />
              </UiField>
              <UiButton type="submit" variant="primary" :loading="saving">Save preferences</UiButton>
            </form>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
