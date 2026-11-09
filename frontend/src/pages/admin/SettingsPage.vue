<script setup lang="ts">
import { IonCheckbox, IonContent, IonInput, IonPage, IonTextarea } from '@ionic/vue';
import { ref, watch } from 'vue';
import LeaveTypesEditor from '@/components/LeaveTypesEditor.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import { api, errorMessage } from '@/lib/api';
import { relative } from '@/lib/format';
import { useAsync } from '@/composables/useAsync';
import { useAuth } from '@/stores/auth';
import { useToast } from '@/stores/toast';

interface Setting {
  key: string;
  value: number | boolean;
  description: string;
  updated_at: string;
}
interface Template {
  key: string;
  subject: string;
  body: string;
  updated_at: string;
}

const toast = useToast();
const auth = useAuth();
const settings = useAsync(() => api.get<Setting[]>('/admin/settings'));
const templates = useAsync(() => api.get<Template[]>('/admin/notification-templates'));
const values = ref<Record<string, number | boolean>>({});
const drafts = ref<Record<string, { subject: string; body: string }>>({});
watch(settings.data, (s) => (values.value = Object.fromEntries((s ?? []).map((x) => [x.key, x.value]))));
watch(templates.data, (t) => (drafts.value = Object.fromEntries((t ?? []).map((x) => [x.key, { subject: x.subject, body: x.body }]))));
const busy = ref<string | null>(null);

async function saveSetting(key: string) {
  busy.value = key;
  try {
    await api.put(`/admin/settings/${key}`, { value: values.value[key] });
    toast.ok('Setting saved');
    await settings.reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
async function saveTemplate(key: string) {
  busy.value = `t:${key}`;
  try {
    await api.put(`/admin/notification-templates/${key}`, drafts.value[key]);
    toast.ok('Template saved');
    await templates.reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    busy.value = null;
  }
}
const LABELS: Record<string, string> = {
  escalation_hours: 'Escalate unattended concerns after (hours)',
  ai_timeout_minutes: 'AI result timeout (minutes)',
  ai_max_attempts: 'AI attempts before the department head writes it',
  pii_retention_days: 'Keep analysis inputs for (days)',
  missing_report_alerts: 'Alert department heads about missing endorsements',
  sms_enabled: 'Queue SMS notifications',
  leave_min_notice_days: 'Leave notice (days ahead)',
  leave_cancel_pending_allowed: 'Staff can cancel pending leave',
  shift_reminder_hours: 'Shift reminder (hours before)',
};
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-3xl">
            <PageHeader title="System rules" description="Hospital-wide rules applied by the database and the scheduled checks, and the email templates." />
            <StateBlock :loading="settings.loading.value" :error="settings.error.value" @retry="settings.reload()">
              <ul class="stagger card divide-y divide-line">
                <li v-for="s in settings.data.value" :key="s.key" class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div class="min-w-0 flex-1">
                    <p class="flex items-center gap-2 text-[14px] font-medium">{{ LABELS[s.key] ?? s.key }}<StatusBadge v-if="s.key === 'sms_enabled' && !auth.config?.integrations.sms.connected" tone="neutral" label="Coming soon" /></p>
                    <p class="text-[13px] text-ink-3">{{ s.description }}<template v-if="s.key === 'sms_enabled' && !auth.config?.integrations.sms.connected"> Text messages are not set up yet, so nothing is sent by SMS.</template></p>
                  </div>
                  <div class="flex items-center gap-2">
                    <IonCheckbox v-if="typeof s.value === 'boolean'" :checked="values[s.key] === true" @ion-change="values[s.key] = $event.detail.checked" :aria-label="LABELS[s.key] ?? s.key" :disabled="s.key === 'sms_enabled' && !auth.config?.integrations.sms.connected" />
                    <IonInput v-else :value="values[s.key] as number" @ion-input="values[s.key] = Number($event.detail.value)" type="number" min="0" class="field-input h-9 w-24 py-0 text-[14px] tnum" :aria-label="LABELS[s.key] ?? s.key"  />
                    <UiButton size="sm" :disabled="values[s.key] === s.value" :loading="busy === s.key" @click="saveSetting(s.key)">Save</UiButton>
                  </div>
                </li>
              </ul>
            </StateBlock>

            <LeaveTypesEditor class="mt-8" />

            <h2 class="mt-8 text-[15px] font-semibold">Email templates</h2>
            <p class="mt-1 mb-3 text-[13px] text-ink-3">
              Placeholders: <code v-pre>{{title}}</code>, <code v-pre>{{body}}</code>, <code v-pre>{{link}}</code>, <code v-pre>{{recipient_name}}</code>. Keep endorsement and patient details out of email — link to the app instead.
            </p>
            <StateBlock :loading="templates.loading.value" :error="templates.error.value" @retry="templates.reload()">
              <div class="space-y-4">
                <form v-for="t in templates.data.value" :key="t.key" class="card space-y-3 p-5" @submit.prevent="saveTemplate(t.key)">
                  <p class="flex justify-between text-[13px]"><span class="font-medium">{{ t.key.replace(/_/g, ' ') }}</span><span class="text-ink-3">updated {{ relative(t.updated_at) }}</span></p>
                  <template v-if="drafts[t.key]">
                    <IonInput v-model="drafts[t.key]!.subject" class="field-input" :maxlength="200" :aria-label="`${t.key} subject`"  />
                    <IonTextarea v-model="drafts[t.key]!.body" class="field-input text-[14px]" :rows="5" :maxlength="4000" :aria-label="`${t.key} body`"  auto-grow />
                  </template>
                  <UiButton size="sm" type="submit" :loading="busy === `t:${t.key}`">Save template</UiButton>
                </form>
              </div>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
