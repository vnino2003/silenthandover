<script setup lang="ts">
import { IonContent, IonInput, IonPage, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { ref } from 'vue';
import { RECORD_TYPE_LABELS, type RecordType } from '@sh/shared';
import { useAuth } from '@/stores/auth';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAsync } from '@/composables/useAsync';
import { useToast } from '@/stores/toast';

interface Rec {
  id: string;
  record_type: RecordType;
  reference_code: string;
  title: string;
  details: string;
  recorded_at: string;
  recorded_by_name: string | null;
}

const toast = useToast();
const auth = useAuth();
const { data, loading, error, reload } = useAsync(() => api.get<Rec[]>('/manager/records'));
const open = ref(false);
const form = ref({ record_type: 'maintenance' as RecordType, reference_code: '', title: '', details: '', recorded_at: '' });
const errors = ref<Record<string, string>>({});
const saving = ref(false);

async function save() {
  saving.value = true;
  errors.value = {};
  try {
    await api.post('/manager/records', { ...form.value, recorded_at: form.value.recorded_at ? new Date(form.value.recorded_at).toISOString() : null });
    open.value = false;
    form.value = { record_type: 'maintenance', reference_code: '', title: '', details: '', recorded_at: '' };
    toast.ok('Record added');
    await reload(true);
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
          <div class="mx-auto max-w-5xl">
            <PageHeader
              title="Unit records"
              :description="`Equipment, supply, staffing and quality records, and approved hospital policies and memoranda. The ${$terms.head} uses them to verify what each ${$terms.reportLower} says.`"
            >
              <UiButton variant="primary" @click="form.record_type = auth.experience.record_types[0]!; open = true">Add record</UiButton>
            </PageHeader>
            <StateBlock :loading="loading" :error="error" :empty="!data?.length" empty-title="No records yet" @retry="reload()">
              <ul class="stagger card divide-y divide-line">
                <li v-for="r in data" :key="r.id" class="px-5 py-3">
                  <p class="flex flex-wrap items-baseline gap-x-2 text-[14px]">
                    <span class="font-medium tnum">{{ r.reference_code }}</span>
                    <span class="text-[12.5px] text-ink-3">{{ RECORD_TYPE_LABELS[r.record_type] }} · {{ dateTime(r.recorded_at) }}<template v-if="r.recorded_by_name"> · {{ r.recorded_by_name }}</template></span>
                  </p>
                  <p class="text-[14px]">{{ r.title }}</p>
                  <p v-if="r.details" class="text-[13.5px] text-ink-2">{{ r.details }}</p>
                </li>
              </ul>
            </StateBlock>

            <UiDialog :open="open" title="Add a unit record" @close="open = false">
              <form id="record-form" class="space-y-4" @submit.prevent="save">
                <div class="grid grid-cols-2 gap-3">
                  <UiField v-slot="{ id, labelledby }" label="Type">
                    <IonSelect :id="id" :aria-labelledby="labelledby" v-model="form.record_type" class="field-input capitalize" interface="popover">
                      <IonSelectOption v-for="t in auth.experience.record_types" :key="t" :value="t">{{ RECORD_TYPE_LABELS[t] }}</IonSelectOption>
                    </IonSelect>
                  </UiField>
                  <UiField v-slot="{ id, labelledby }" label="Reference" :error="errors.reference_code">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="form.reference_code" class="field-input" placeholder="MR-2301" :maxlength="60"  />
                  </UiField>
                </div>
                <UiField v-slot="{ id, labelledby }" label="Title" :error="errors.title">
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="form.title" class="field-input" :maxlength="160"  />
                </UiField>
                <UiField v-slot="{ id, labelledby }" label="Details" optional>
                  <IonTextarea :id="id" :aria-labelledby="labelledby" v-model="form.details" class="field-input" :rows="3" :maxlength="2000"  auto-grow />
                </UiField>
                <UiField v-slot="{ id, labelledby }" label="Recorded at" hint="Leave empty for now." optional>
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="form.recorded_at" type="datetime-local" class="field-input"  />
                </UiField>
              </form>
              <template #footer>
                <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
                <UiButton variant="primary" type="submit" form="record-form" :loading="saving">Add record</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
