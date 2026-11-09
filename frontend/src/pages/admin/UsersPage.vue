<script setup lang="ts">
import { IonCheckbox, IonContent, IonInput, IonPage, IonSelect, IonSelectOption } from '@ionic/vue';
import { computed, ref } from 'vue';
import { ROLE_LABELS, ROLES, type Role } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAdminRefs, type AdminUser, type InviteResult } from '@/composables/useAdminRefs';
import { useAsync } from '@/composables/useAsync';
import { useToast } from '@/stores/toast';

const toast = useToast();
const { departments, users, teamsFor } = useAdminRefs();
/** Whether invitation emails really go out (Integrations → Email). */
const emailSettings = useAsync(() => api.get<{ simulated: boolean }>('/admin/email'));
const emailOn = computed(() => emailSettings.data.value?.simulated === false);
const search = ref('');
const rows = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (users.data.value ?? []).filter((u) => !q || `${u.full_name} ${u.email} ${u.department_name ?? ''}`.toLowerCase().includes(q));
});

interface Form {
  id: string | null;
  full_name: string;
  email: string;
  role: Role;
  department_id: string | null;
  team_id: string | null;
  phone: string;
  is_active: boolean;
  job_title: string;
}
const editing = ref<Form | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

function openNew() {
  errors.value = {};
  editing.value = { id: null, full_name: '', email: '', role: 'employee', department_id: departments.data.value?.[0]?.id ?? null, team_id: null, phone: '', is_active: true, job_title: '' };
}
function openEdit(u: AdminUser) {
  errors.value = {};
  editing.value = { id: u.id, full_name: u.full_name, email: u.email, role: u.role, department_id: u.department_id, team_id: u.team_id, phone: u.phone ?? '', is_active: u.is_active, job_title: u.job_title ?? '' };
}

// ---- Invitations: the person chooses their own password from a one-time link sent by email.
const sent = ref<(InviteResult & { name: string }) | null>(null);
const inviting = ref<string | null>(null);
const confirmRevoke = ref<AdminUser | null>(null);

async function createUser(body: Record<string, unknown>) {
  const r = await api.post<{ id: string; invite: InviteResult }>('/admin/users', body);
  showSent(r.invite, String(body.full_name));
  return r.id;
}
function showSent(r: InviteResult, name: string) {
  if (r.status === 'sent') toast.ok(`${r.purpose === 'invite' ? 'Invitation' : 'Password reset link'} emailed to ${r.to}`);
  // Not emailed: show the link so it can be passed on another way.
  else sent.value = { ...r, name };
}
async function sendLink(u: AdminUser) {
  inviting.value = u.id;
  try {
    showSent(await api.post<InviteResult>(`/admin/users/${u.id}/invite`), u.full_name);
    editing.value = null;
    await users.reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    inviting.value = null;
  }
}
async function revoke() {
  const u = confirmRevoke.value!;
  inviting.value = u.id;
  try {
    await api.post(`/admin/users/${u.id}/invite/revoke`);
    toast.ok('Link cancelled. It no longer works.');
    confirmRevoke.value = null;
    editing.value = null;
    await users.reload(true);
  } catch (err) {
    toast.error(errorMessage(err));
  } finally {
    inviting.value = null;
  }
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(sent.value!.link!);
    toast.ok('Link copied');
  } catch {
    toast.error('Could not copy. Select the link and copy it.');
  }
}
const current = computed(() => (editing.value?.id ? (users.data.value ?? []).find((u) => u.id === editing.value!.id) ?? null : null));
const signInBadge = (u: AdminUser): { tone: 'ok' | 'neutral' | 'warn' | 'info'; label: string } =>
  !u.is_active ? { tone: 'neutral', label: 'Deactivated' } : u.sign_in === 'invited' ? { tone: 'info', label: 'Invited' } : u.sign_in === 'expired' ? { tone: 'warn', label: 'Invitation expired' } : { tone: 'ok', label: 'Active' };

async function save() {
  const f = editing.value!;
  saving.value = true;
  errors.value = {};
  const common = { full_name: f.full_name, role: f.role, department_id: f.role === 'admin' ? null : f.department_id, team_id: f.role === 'admin' ? null : f.team_id, phone: f.phone.trim() || null };
  try {
    const id = f.id
      ? (await api.patch(`/admin/users/${f.id}`, { ...common, is_active: f.is_active }), f.id)
      : await createUser({ ...common, email: f.email.trim() });
    const before = (users.data.value ?? []).find((u) => u.id === f.id)?.job_title ?? '';
    if (f.job_title.trim() !== before) await api.patch(`/admin/users/${id}/job-title`, { job_title: f.job_title.trim() || null });
    if (f.id) toast.ok('User updated');
    editing.value = null;
    await users.reload(true);
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
            <PageHeader title="User accounts" description="Accounts, roles and department assignments. New people get an email invitation and choose their own password.">
              <IonInput v-model="search" class="field-input h-9 w-56 py-0 text-[14px]" placeholder="Search" aria-label="Search users"  />
              <UiButton variant="primary" @click="openNew">Add user</UiButton>
            </PageHeader>
            <StateBlock :loading="users.loading.value" :error="users.error.value" :empty="!rows.length" empty-title="No users found" @retry="users.reload()">
              <div class="table-region card overflow-x-auto" tabindex="0" role="region" aria-label="User directory — scroll horizontally to see all columns">
                <table class="w-full min-w-[640px] text-left text-[14px]">
                  <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
                    <tr><th class="px-5 py-2.5 font-medium">Name</th><th class="px-3 py-2.5 font-medium">Role</th><th class="px-3 py-2.5 font-medium">Department</th><th class="px-3 py-2.5 font-medium">Status</th><th class="px-5 py-2.5" /></tr>
                  </thead>
                  <tbody class="stagger divide-y divide-line">
                    <tr v-for="u in rows" :key="u.id" class="cursor-pointer transition-colors hover:bg-canvas" :class="{ 'text-ink-3': !u.is_active }" @click="openEdit(u)">
                      <td class="px-5 py-2.5"><span class="font-medium">{{ u.full_name }}</span><span class="block text-[12.5px] text-ink-3">{{ u.email }}</span></td>
                      <td class="px-3 py-2.5">{{ ROLE_LABELS[u.role] }}</td>
                      <td class="px-3 py-2.5">{{ u.department_name ?? '—' }}</td>
                      <td class="px-3 py-2.5"><StatusBadge :tone="signInBadge(u).tone" :label="signInBadge(u).label" /></td>
                      <td class="px-5 py-2.5 text-right"><UiButton size="sm" variant="ghost" @click.stop="openEdit(u)">Edit</UiButton></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </StateBlock>

            <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit user' : 'Add user'" @close="editing = null">
              <form v-if="editing" id="user-form" class="space-y-4" @submit.prevent="save">
                <UiField v-slot="{ id, labelledby }" label="Full name" :error="errors.full_name">
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.full_name" class="field-input" :maxlength="120"  />
                </UiField>
                <UiField v-if="editing.role !== 'admin'" v-slot="{ id, labelledby }" label="Job title" optional hint="Shown on schedules, for example Staff nurse, Forklift operator or Cashier." :error="errors.job_title">
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.job_title" class="field-input" :maxlength="80"  />
                </UiField>
                <template v-if="!editing.id">
                  <UiField v-slot="{ id, labelledby }" label="Work email" :error="errors.email">
                    <IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.email" type="email" class="field-input" autocomplete="off"  />
                  </UiField>
                  <p class="flex gap-2 rounded-md bg-canvas px-3 py-2.5 text-[12.5px] text-ink-2">
                    <svg viewBox="0 0 20 20" fill="none" class="mt-px size-4 shrink-0 text-accent" aria-hidden="true"><path d="M3 5.5h14v9H3z M3.5 6l6.5 5 6.5-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
                    <span v-if="emailOn">We’ll email an invitation to this address. They open the link and choose their own password; it works once and expires in 7 days.</span>
                    <span v-else>Email isn’t connected yet (Integrations → Email), so you’ll get the invitation link to send them yourself. They choose their own password with it.</span>
                  </p>
                </template>
                <div class="grid grid-cols-2 gap-3">
                  <UiField v-slot="{ id, labelledby }" label="Role">
                    <IonSelect :id="id" :aria-labelledby="labelledby" v-model="editing.role" class="field-input capitalize" interface="popover">
                      <IonSelectOption v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</IonSelectOption>
                    </IonSelect>
                  </UiField>
                  <UiField v-if="editing.role !== 'admin'" v-slot="{ id, labelledby }" label="Department" :error="errors.department_id">
                    <IonSelect :id="id" :aria-labelledby="labelledby" v-model="editing.department_id" class="field-input" @ion-change="editing!.team_id = null" interface="popover">
                      <IonSelectOption v-for="d in departments.data.value ?? []" :key="d.id" :value="d.id">{{ d.name }}</IonSelectOption>
                    </IonSelect>
                  </UiField>
                </div>
                <UiField v-if="editing.role !== 'admin' && teamsFor(editing.department_id).length" v-slot="{ id, labelledby }" label="Team" optional>
                  <IonSelect :id="id" :aria-labelledby="labelledby" v-model="editing.team_id" class="field-input" interface="popover">
                    <IonSelectOption :value="null">No team</IonSelectOption>
                    <IonSelectOption v-for="t in teamsFor(editing.department_id)" :key="t.id" :value="t.id">{{ t.name }}</IonSelectOption>
                  </IonSelect>
                </UiField>
                <UiField v-slot="{ id, labelledby }" label="Mobile number" optional :error="errors.phone">
                  <IonInput :id="id" :aria-labelledby="labelledby" v-model="editing.phone" type="tel" class="field-input"  />
                </UiField>
                <IonCheckbox v-if="editing.id" class="flex items-center gap-2 text-[14px]" v-model="editing.is_active" label-placement="end" justify="start">Account active</IonCheckbox>
                <section v-if="current && current.is_active" class="rounded-md border border-line px-3 py-3" aria-label="Sign-in">
                  <p class="text-[13.5px] font-medium">Sign-in</p>
                  <p class="mt-0.5 text-[12.5px] text-ink-3">
                    <template v-if="current.sign_in === 'invited' && current.invitation">
                      Invited{{ current.invitation.sent_at ? ` ${dateTime(current.invitation.sent_at)}` : '' }} — waiting for them to choose a password. The link expires {{ dateTime(current.invitation.expires_at) }}.
                      <span v-if="current.invitation.send_status === 'failed'" class="block text-bad">The email failed: {{ current.invitation.send_error }}</span>
                    </template>
                    <template v-else-if="current.sign_in === 'expired'">The invitation expired or was cancelled before a password was chosen. Send a new one.</template>
                    <template v-else-if="current.invitation">A password reset link is open until {{ dateTime(current.invitation.expires_at) }}. Their current password still works.</template>
                    <template v-else>Signs in with their own password. If they forget it, send a reset link.</template>
                  </p>
                  <div class="mt-2.5 flex flex-wrap gap-2">
                    <UiButton size="sm" :loading="inviting === current.id" @click="sendLink(current)">
                      {{ current.sign_in === 'ready' ? 'Send password reset link' : current.sign_in === 'invited' ? 'Resend invitation' : 'Send new invitation' }}
                    </UiButton>
                    <UiButton v-if="current.invitation" size="sm" variant="ghost" @click="confirmRevoke = current">Cancel link</UiButton>
                  </div>
                </section>
                <p v-if="editing.role === 'admin'" class="text-[12.5px] text-ink-3">System administrators set up accounts, departments and settings. They cannot read endorsements or AI drafts, and they do not approve.</p>
                <p v-else-if="editing.role === 'manager'" class="text-[12.5px] text-ink-3">Department heads (e.g. Head Nurse) set the duty schedule and approve every shift endorsement from their unit.</p>
              </form>
              <template #footer>
                <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
                <UiButton variant="primary" type="submit" form="user-form" :loading="saving">{{ editing?.id ? 'Save changes' : emailOn ? 'Create and send invitation' : 'Create and get link' }}</UiButton>
              </template>
            </UiDialog>

            <UiDialog
              :open="Boolean(sent)"
              :title="sent?.status === 'failed' ? 'The email could not be sent' : sent?.purpose === 'reset' ? 'Password reset link ready' : 'Account created'"
              :description="sent ? `Send this link to ${sent.name} (${sent.to}). It works once and expires ${dateTime(sent.expires_at)}.` : undefined"
              @close="sent = null"
            >
              <template v-if="sent">
                <p v-if="sent.status === 'failed'" class="mb-3 rounded-md bg-bad-soft px-3 py-2 text-[13px] text-bad">{{ sent.error }}</p>
                <p v-else class="mb-3 text-[13px] text-ink-2">Email isn’t connected, so nothing was emailed. Connect Gmail on Integrations to send invitations automatically.</p>
                <div class="flex gap-2">
                  <IonInput :value="sent.link" readonly class="field-input font-mono text-[12px]" aria-label="Invitation link" @ion-focus="($event.target as HTMLIonInputElement).getInputElement().then((el) => el.select())"  />
                  <UiButton class="shrink-0" @click="copyLink">Copy</UiButton>
                </div>
                <p class="mt-2 text-[12.5px] text-ink-3">Share it privately (for example a direct message). Anyone with the link can set this account’s password.</p>
              </template>
              <template #footer>
                <UiButton variant="primary" @click="sent = null">Done</UiButton>
              </template>
            </UiDialog>

            <UiDialog :open="Boolean(confirmRevoke)" title="Cancel this link?" :description="confirmRevoke ? `The link sent to ${confirmRevoke.email} stops working. You can send a new one later.` : undefined" @close="confirmRevoke = null">
              <template #footer>
                <UiButton variant="ghost" @click="confirmRevoke = null">Keep it</UiButton>
                <UiButton variant="danger" :loading="inviting === confirmRevoke?.id" @click="revoke">Cancel link</UiButton>
              </template>
            </UiDialog>
          </div>
      </div>
    </IonContent>
  </IonPage>
</template>
