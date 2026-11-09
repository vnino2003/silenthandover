<script setup lang="ts">
import { IonTextarea } from '@ionic/vue';
import { computed, ref, watch } from 'vue';
import { OrganizationRulesInput, type OrganizationRules } from '@sh/shared';
import StateBlock from '@/components/ui/StateBlock.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiDialog from '@/components/ui/UiDialog.vue';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useAsync } from '@/lib/useAsync';
import { useToast } from '@/stores/toast';

/**
 * The administrator's organization rules: added to elements 3 and 5 of every prompt (report
 * cleaning and Mica). Everything else in the prompt is locked. Each save is a new, audited version.
 */
export interface RulesView {
  current: OrganizationRules;
  defaults: OrganizationRules;
  history: { version: number; is_default: boolean; created_at: string; created_by_name: string | null; policy_count: number; never_count: number }[];
}
const emit = defineEmits<{ saved: [rules: OrganizationRules] }>();
const toast = useToast();
const { data, loading, error, reload } = useAsync(() => api.get<RulesView>('/admin/ai/rules'));
const policy = ref<string[]>([]);
const never = ref<string[]>([]);
const saving = ref(false);
const resetting = ref(false);
const confirmReset = ref(false);
const serverError = ref('');
watch(data, (v) => {
  if (!v) return;
  policy.value = [...v.current.policy_rules];
  never.value = [...v.current.negative_constraints];
});
const LISTS = [
  { key: 'policy', title: 'Policy rules', element: '3. Context and policy rules', hint: 'What the AI should keep in mind, e.g. “Mention the ward when reporting equipment problems.”' },
  { key: 'never', title: '“Never” rules', element: '5. Negative constraints', hint: 'What the AI must never do, e.g. “Never mention patient bed numbers.”' },
] as const;
const lists = { policy, never };
const clean = (l: string[]) => l.map((r) => r.trim()).filter(Boolean);
const changed = computed(() => !!data.value && (JSON.stringify(clean(policy.value)) !== JSON.stringify(data.value.current.policy_rules) || JSON.stringify(clean(never.value)) !== JSON.stringify(data.value.current.negative_constraints)));
// The same rules the server applies, checked here first for a quick message.
const localError = computed(() => {
  const r = OrganizationRulesInput.safeParse({ policy_rules: clean(policy.value), negative_constraints: clean(never.value) });
  return r.success ? '' : (r.error.issues[0]?.message ?? 'Check the rules');
});

async function save() {
  saving.value = true;
  serverError.value = '';
  try {
    const v = await api.put<RulesView>('/admin/ai/rules', { policy_rules: clean(policy.value), negative_constraints: clean(never.value) });
    data.value = v;
    toast.ok(`Rules saved as version ${v.current.version}`);
    emit('saved', v.current);
  } catch (e) {
    serverError.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
async function reset() {
  resetting.value = true;
  serverError.value = '';
  try {
    const v = await api.post<RulesView>('/admin/ai/rules/reset', {});
    data.value = v;
    confirmReset.value = false;
    toast.ok(`Default rules restored as version ${v.current.version}`);
    emit('saved', v.current);
  } catch (e) {
    serverError.value = errorMessage(e);
  } finally {
    resetting.value = false;
  }
}
</script>

<template>
  <StateBlock :loading="loading" :error="error" @retry="reload()">
    <div v-if="data" class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section class="space-y-5">
        <div class="rounded-lg border border-line bg-canvas p-4 text-[13px] leading-relaxed text-ink-2">
          <p class="font-medium text-ink">What you can change</p>
          <p class="mt-1">
            Your rules are added to <span class="font-medium">two of the six elements</span> of every prompt, for cleaning shift endorsements and for Mica. The role, the task, the injection shield, the built-in rules and the output format stay locked, and your rules can never override them.
            Names, health, contact and ID details are still removed before sending, and every answer is still checked.
          </p>
        </div>
        <div v-for="list in LISTS" :key="list.key" class="card p-5">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="text-[15px] font-semibold">{{ list.title }} <span class="ml-1 text-[12px] font-normal text-ink-3">· {{ list.element }}</span></h3>
            <span class="text-[12px] text-ink-3 tnum">{{ lists[list.key].value.length }} / 10</span>
          </div>
          <p class="mt-1 text-[12.5px] text-ink-3">{{ list.hint }}</p>
          <ol class="mt-3 space-y-2">
            <li v-for="(_, i) in lists[list.key].value" :key="i" class="flex items-start gap-2">
              <span class="mt-2 w-5 shrink-0 text-right text-[12px] text-ink-3 tnum">{{ i + 1 }}.</span>
              <IonTextarea v-model="lists[list.key].value[i]" class="field-input min-h-[2.5rem] flex-1" :rows="1" :maxlength="300" :aria-label="`${list.title} ${i + 1}`"  auto-grow />
              <UiButton size="sm" variant="danger" class="mt-1.5" :aria-label="`Remove ${list.title.toLowerCase()} ${i + 1}`" @click="lists[list.key].value.splice(i, 1)">Remove</UiButton>
            </li>
          </ol>
          <UiButton class="mt-3" size="sm" :disabled="lists[list.key].value.length >= 10" @click="lists[list.key].value.push('')">Add a rule</UiButton>
        </div>
        <p v-if="serverError || (changed && localError)" role="alert" class="rounded-md bg-bad-soft p-3 text-[13px] text-bad">{{ serverError || localError }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <UiButton variant="primary" :loading="saving" :disabled="!changed || Boolean(localError)" @click="save">Save as version {{ (data.history[0]?.version ?? data.current.version) + 1 }}</UiButton>
          <UiButton variant="ghost" :disabled="!changed" @click="policy = [...data.current.policy_rules]; never = [...data.current.negative_constraints]">Undo changes</UiButton>
          <UiButton variant="ghost" class="ml-auto" @click="confirmReset = true">Reset to default</UiButton>
        </div>
      </section>

      <aside class="space-y-3">
        <div class="card p-4">
          <h3 class="text-[14px] font-semibold">In use now</h3>
          <p class="mt-1 text-[12.5px] text-ink-3">Version {{ data.current.version }}. Every new endorsement and Mica request uses it; each endorsement shows the version it used.</p>
        </div>
        <div class="card p-4">
          <h3 class="text-[14px] font-semibold">History</h3>
          <ul class="mt-2 divide-y divide-line text-[12.5px]">
            <li v-for="h in data.history" :key="h.version" class="py-2">
              <span class="font-medium tnum">v{{ h.version }}</span>
              <span class="text-ink-3"> · {{ h.is_default ? 'System default' : (h.created_by_name ?? 'Administrator') }} · {{ dateTime(h.created_at) }}</span>
              <span class="block text-ink-3">{{ h.policy_count }} policy, {{ h.never_count }} “never”</span>
            </li>
          </ul>
          <p class="mt-2 text-[11.5px] text-ink-3">Old versions are kept unchanged. Every save is in the audit log.</p>
        </div>
      </aside>
    </div>

    <UiDialog :open="confirmReset" title="Reset to the default rules?" description="Your organization rules are replaced by the system defaults, saved as a new version. Earlier versions stay in the history." @close="!resetting && (confirmReset = false)">
      <ul class="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
        <li v-for="r in [...(data?.defaults.policy_rules ?? []), ...(data?.defaults.negative_constraints ?? [])]" :key="r">{{ r }}</li>
      </ul>
      <template #footer>
        <UiButton variant="ghost" :disabled="resetting" @click="confirmReset = false">Cancel</UiButton>
        <UiButton variant="primary" :loading="resetting" @click="reset">Reset to default</UiButton>
      </template>
    </UiDialog>
  </StateBlock>
</template>
