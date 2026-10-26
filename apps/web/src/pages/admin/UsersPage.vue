<script setup lang="ts">
import { computed, ref } from 'vue';
import { ROLE_LABELS, ROLES, type Role } from '@sh/shared';
import PageHeader from '@/components/ui/PageHeader.vue';
import StateBlock from '@/components/ui/StateBlock.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import UiField from '@/components/ui/UiField.vue';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAdminRefs, type AdminUser } from '@/lib/useAdminRefs';
import { useToast } from '@/stores/toast';

const toast = useToast();
const { departments, users, teamsFor } = useAdminRefs();
const search = ref('');
const rows = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (users.data.value ?? []).filter((u) => !q || `${u.full_name} ${u.email} ${u.department_name ?? ''}`.toLowerCase().includes(q));
});

interface Form {
  id: string | null;
  full_name: string;
  email: string;
  password: string;
  role: Role;
  department_id: string | null;
  team_id: string | null;
  phone: string;
  is_active: boolean;
}
const editing = ref<Form | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

function openNew() {
  errors.value = {};
  editing.value = { id: null, full_name: '', email: '', password: '', role: 'employee', department_id: departments.data.value?.[0]?.id ?? null, team_id: null, phone: '', is_active: true };
}
function openEdit(u: AdminUser) {
  errors.value = {};
  editing.value = { id: u.id, full_name: u.full_name, email: u.email, password: '', role: u.role, department_id: u.department_id, team_id: u.team_id, phone: u.phone ?? '', is_active: u.is_active };
}

async function save() {
  const f = editing.value!;
  saving.value = true;
  errors.value = {};
  const common = { full_name: f.full_name, role: f.role, department_id: f.role === 'admin' ? null : f.department_id, team_id: f.role === 'admin' ? null : f.team_id, phone: f.phone.trim() || null };
  try {
    if (f.id) await api.patch(`/admin/users/${f.id}`, { ...common, is_active: f.is_active });
    else await api.post('/admin/users', { ...common, email: f.email, password: f.password });
    toast.ok(f.id ? 'User updated' : 'User created');
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
  <div class="mx-auto max-w-5xl">
    <PageHeader title="Users" description="Accounts, roles and department assignments. Deactivated users cannot sign in.">
      <input v-model="search" class="field-input h-9 w-56 py-0 text-[14px]" placeholder="Search" aria-label="Search users" />
      <UiButton variant="primary" @click="openNew">Add user</UiButton>
    </PageHeader>
    <StateBlock :loading="users.loading.value" :error="users.error.value" :empty="!rows.length" empty-title="No users found" @retry="users.reload()">
      <div class="card overflow-x-auto">
        <table class="w-full min-w-[640px] text-left text-[14px]">
          <thead class="border-b border-line bg-canvas text-[12px] tracking-wide text-ink-3 uppercase">
            <tr><th class="px-5 py-2.5 font-medium">Name</th><th class="px-3 py-2.5 font-medium">Role</th><th class="px-3 py-2.5 font-medium">Department</th><th class="px-3 py-2.5 font-medium">Status</th><th class="px-5 py-2.5" /></tr>
          </thead>
          <tbody class="stagger divide-y divide-line">
            <tr v-for="u in rows" :key="u.id" class="cursor-pointer transition-colors hover:bg-canvas" :class="{ 'text-ink-3': !u.is_active }" @click="openEdit(u)">
              <td class="px-5 py-2.5"><span class="font-medium">{{ u.full_name }}</span><span class="block text-[12.5px] text-ink-3">{{ u.email }}</span></td>
              <td class="px-3 py-2.5">{{ ROLE_LABELS[u.role] }}</td>
              <td class="px-3 py-2.5">{{ u.department_name ?? '—' }}</td>
              <td class="px-3 py-2.5"><StatusBadge :tone="u.is_active ? 'ok' : 'neutral'" :label="u.is_active ? 'Active' : 'Deactivated'" /></td>
              <td class="px-5 py-2.5 text-right"><UiButton size="sm" variant="ghost" @click.stop="openEdit(u)">Edit</UiButton></td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <UiDialog :open="Boolean(editing)" :title="editing?.id ? 'Edit user' : 'Add user'" @close="editing = null">
      <form v-if="editing" id="user-form" class="space-y-4" @submit.prevent="save">
        <UiField v-slot="{ id }" label="Full name" :error="errors.full_name">
          <input :id="id" v-model="editing.full_name" class="field-input" maxlength="120" />
        </UiField>
        <template v-if="!editing.id">
          <UiField v-slot="{ id }" label="Work email" :error="errors.email">
            <input :id="id" v-model="editing.email" type="email" class="field-input" autocomplete="off" />
          </UiField>
          <UiField v-slot="{ id }" label="Initial password" hint="At least 10 characters. Share it privately; the user should change it." :error="errors.password">
            <input :id="id" v-model="editing.password" type="password" class="field-input" autocomplete="new-password" />
          </UiField>
        </template>
        <div class="grid grid-cols-2 gap-3">
          <UiField v-slot="{ id }" label="Role">
            <select :id="id" v-model="editing.role" class="field-input capitalize">
              <option v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
            </select>
          </UiField>
          <UiField v-if="editing.role !== 'admin'" v-slot="{ id }" label="Department" :error="errors.department_id">
            <select :id="id" v-model="editing.department_id" class="field-input" @change="editing!.team_id = null">
              <option v-for="d in departments.data.value ?? []" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </UiField>
        </div>
        <UiField v-if="editing.role !== 'admin' && teamsFor(editing.department_id).length" v-slot="{ id }" label="Team" optional>
          <select :id="id" v-model="editing.team_id" class="field-input">
            <option :value="null">No team</option>
            <option v-for="t in teamsFor(editing.department_id)" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </UiField>
        <UiField v-slot="{ id }" label="Mobile number" optional :error="errors.phone">
          <input :id="id" v-model="editing.phone" type="tel" class="field-input" />
        </UiField>
        <label v-if="editing.id" class="flex items-center gap-2 text-[14px]"><input v-model="editing.is_active" type="checkbox" class="size-4 accent-accent" /> Account active</label>
        <p v-if="editing.role === 'admin'" class="text-[12.5px] text-ink-3">Admins set up accounts, departments and settings. They cannot read reports or AI drafts, and they do not approve.</p>
        <p v-else-if="editing.role === 'manager'" class="text-[12.5px] text-ink-3">Supervisors build the schedule and approve every report from their department.</p>
      </form>
      <template #footer>
        <UiButton variant="ghost" @click="editing = null">Cancel</UiButton>
        <UiButton variant="primary" type="submit" form="user-form" :loading="saving">{{ editing?.id ? 'Save changes' : 'Create user' }}</UiButton>
      </template>
    </UiDialog>
  </div>
</template>
