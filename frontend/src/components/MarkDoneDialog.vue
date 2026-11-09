<script setup lang="ts">
import { IonTextarea } from '@ionic/vue';
import { ref, watch } from 'vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import { api, errorMessage } from '@/lib/api';
import { preparePhoto, type PhotoUpload } from '@/lib/photo';
import { useToast } from '@/stores/toast';
import { useAuth } from '@/stores/auth';

/**
 * A worker marks a problem or task as done, with a short note and an optional photo as proof.
 * It moves to "waiting for supervisor"; the supervisor confirms it before it counts as resolved.
 */
const props = defineProps<{ issue: { id: string; code: string; title: string; kind?: string } | null }>();
const emit = defineEmits<{ close: []; done: [] }>();
const toast = useToast();
const auth = useAuth();

const note = ref('');
const photo = ref<PhotoUpload | null>(null);
const photoError = ref<string | null>(null);
const busy = ref(false);
const preparing = ref(false);

watch(
  () => props.issue,
  () => {
    note.value = '';
    photo.value = null;
    photoError.value = null;
  },
);

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  preparing.value = true;
  photoError.value = null;
  try {
    photo.value = await preparePhoto(file);
  } catch (err) {
    photoError.value = err instanceof Error ? err.message : 'That photo could not be used';
  } finally {
    preparing.value = false;
  }
}

async function submit() {
  if (!props.issue) return;
  busy.value = true;
  try {
    await api.post(`/issues/${props.issue.id}/transition`, {
      to: 'resolution_submitted',
      note: note.value,
      photo: photo.value ? { content_type: photo.value.content_type, data_base64: photo.value.data_base64 } : null,
    });
    toast.ok(`Marked as done. Your ${auth.terms.head} will confirm it.`);
    emit('done');
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiDialog :open="Boolean(issue)" :title="issue?.kind === 'task' ? 'Mark task as done' : 'Mark concern as resolved'" :description="issue ? `${issue.code} · ${issue.title}` : ''" @close="emit('close')">
    <div class="space-y-4">
      <label class="block text-[14px] font-medium">
        What did you do?
        <IonTextarea v-model="note" class="field-input mt-1" :rows="3" :maxlength="2000" :placeholder="`Describe the action taken and any work order or reference number. Your ${$terms.head} will verify it.`"  auto-grow />
      </label>
      <div>
        <p class="text-[14px] font-medium">Photo proof <span class="font-normal text-ink-3">(optional, recommended)</span></p>
        <div class="mt-2 flex items-center gap-3">
          <img v-if="photo" :src="photo.preview" alt="Selected photo" class="h-20 w-28 rounded-md border border-line object-cover" />
          <label class="inline-flex h-10 cursor-pointer items-center rounded-md border border-line-strong bg-surface px-4 text-[14px] hover:bg-sunken">
            {{ preparing ? 'Preparing…' : photo ? 'Change photo' : 'Take or choose a photo' }}
            <input type="file" accept="image/*" capture="environment" class="sr-only" @change="onFile" />
          </label>
          <UiButton size="sm" variant="danger" v-if="photo" @click="photo = null">Remove</UiButton>
        </div>
        <p v-if="photoError" class="mt-1 text-[13px] text-bad">{{ photoError }}</p>
      </div>
      <p class="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">Your {{ $terms.head }} checks this before it’s marked resolved.</p>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="emit('close')">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" :disabled="note.trim().length < 3 || preparing" @click="submit">Mark as done</UiButton>
    </template>
  </UiDialog>
</template>
