<script setup lang="ts">
import { IonContent, IonPage, IonSelect, IonSelectOption } from '@ionic/vue';
import { ref } from 'vue';
import { ROLE_LABELS, type Role } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useAuth } from '@/stores/auth';

interface Entry {
  id: string;
  actor_role: string;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  department_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

const auth = useAuth();
const action = ref('');
const { data, loading, refreshing, error, reload } = useAsync(
  () => api.get<Entry[]>(`/audit?limit=200${action.value ? `&action=${encodeURIComponent(action.value)}` : ''}`),
  [action],
);
const PREFIXES = ['', 'report.', 'analysis.', 'handover.', 'issue.', 'shift', 'user.', 'setting.', 'automation.'];

function describe(details: Record<string, unknown>) {
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join(' · ');
}
</script>

<template>
  <IonPage>
    <IonContent class="sh-content">
      <div class="sh-page page-enter">
          <div class="mx-auto max-w-5xl">
            <PageHeader
              title="Audit log"
              :description="auth.role === 'admin' ? 'Append-only record of actions across the system. Endorsement content is never stored here.' : 'Append-only record of actions in your department.'"
            >
              <IonSelect v-model="action" class="field-input h-9 w-48 py-0 text-[14px]" aria-label="Filter by action" interface="popover">
                <IonSelectOption v-for="p in PREFIXES" :key="p" :value="p">{{ p ? p.replace('.', '') : 'All actions' }}</IonSelectOption>
              </IonSelect>
            </PageHeader>
            <StateBlock :loading="loading" :refreshing="refreshing" :error="error" :empty="!data?.length" empty-title="No entries" @retry="reload()">
              <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="Audit history — scroll horizontally to see all columns">
                <table class="w-full min-w-[640px] text-left text-[13.5px]">
                  <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                    <tr>
                      <th class="px-4 py-2.5 font-medium">When</th>
                      <th class="px-3 py-2.5 font-medium">Who</th>
                      <th class="px-3 py-2.5 font-medium">Action</th>
                      <th class="px-4 py-2.5 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody class="stagger divide-y divide-line">
                    <tr v-for="e in data" :key="e.id" class="align-top">
                      <td class="px-4 py-2.5 whitespace-nowrap text-ink-3 tnum">{{ dateTime(e.created_at) }}</td>
                      <td class="px-3 py-2.5">{{ e.actor_name ?? 'System' }}<span class="block text-[12px] text-ink-3">{{ ROLE_LABELS[e.actor_role as Role] ?? 'System' }}</span></td>
                      <td class="px-3 py-2.5 font-medium">{{ e.action }}<span class="block text-[12px] font-normal text-ink-3">{{ e.entity_type }}<template v-if="e.department_name"> · {{ e.department_name }}</template></span></td>
                      <td class="px-4 py-2.5 text-ink-2">{{ describe(e.details) || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </StateBlock>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
