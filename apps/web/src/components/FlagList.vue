<script setup lang="ts">
import { IonInput, IonItem, IonSelect, IonSelectOption } from '@ionic/vue';
import { FLAG_LABELS, FLAG_RESOLUTION_LABELS, type FlagResolution, type ServerFlag } from '@sh/shared';

const props = defineProps<{
  flags: ServerFlag[];
  resolutions: Record<number, { resolution: FlagResolution['resolution'] | ''; note: string }>;
  readonly?: boolean;
}>();
defineEmits<{ highlight: [text: string] }>();

const ORIGIN: Record<ServerFlag['origin'], string> = {
  model: 'AI model',
  grounding_check: 'Grounding check',
  injection_detector: 'Injection detector',
  sanitizer: 'Privacy check',
};
const SERIOUS = new Set(['safety_concern', 'possible_prompt_injection', 'unverified_repair']);

function itemLabel(ref: string | null) {
  if (!ref) return null;
  const m = /^(\w+)\[(\d+)\]$/.exec(ref);
  if (!m) return ref;
  const name = { completed_tasks: 'Task completed', unresolved_issues: 'Unresolved concern', pending_actions: 'Pending task' }[m[1]!] ?? m[1];
  return `${name} ${Number(m[2]) + 1}`;
}
const resolutionOptions = Object.entries(FLAG_RESOLUTION_LABELS) as [FlagResolution['resolution'], string][];
void props;
</script>

<template>
  <ol class="stagger space-y-3">
    <li
      v-for="(f, i) in flags"
      :key="i"
      class="rounded-md border px-3.5 py-3"
      :class="resolutions[i]?.resolution ? 'border-line bg-surface' : SERIOUS.has(f.type) ? 'border-bad/30 bg-bad-soft/40' : 'border-warn/30 bg-warn-soft/50'"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p class="text-[14px] font-medium" :class="SERIOUS.has(f.type) ? 'text-bad' : 'text-warn'">{{ FLAG_LABELS[f.type] }}</p>
        <p class="text-[12px] text-ink-3">{{ ORIGIN[f.origin] }}<template v-if="itemLabel(f.item_ref)"> · {{ itemLabel(f.item_ref) }}</template></p>
      </div>
      <p class="mt-1 text-[13.5px] text-ink-2">{{ f.detail }}</p>
      <IonItem button :detail="false" lines="none" class="sh-row"
        v-if="f.source_evidence"
       
        @click="$emit('highlight', f.source_evidence)"
      ><div class="mt-1.5 block w-full min-w-0 rounded-sm border-l-2 border-line-strong pl-2.5 text-left text-[13px] text-ink-2 italic hover:border-accent hover:text-ink">
        “{{ f.source_evidence }}”
      </div></IonItem>
      <div v-if="!readonly" class="mt-2.5 grid gap-2 sm:grid-cols-[220px_1fr]">
        <IonSelect v-model="resolutions[i]!.resolution" class="field-input h-9 py-0 text-[13.5px]" :aria-label="`Decision for flag ${i + 1}`" interface="popover">
          <IonSelectOption value="" disabled>Choose a decision…</IonSelectOption>
          <IonSelectOption v-for="[value, label] in resolutionOptions" :key="value" :value="value">{{ label }}</IonSelectOption>
        </IonSelect>
        <IonInput v-model="resolutions[i]!.note" class="field-input h-9 py-0 text-[13.5px]" placeholder="Note (optional)" :maxlength="500" :aria-label="`Note for flag ${i + 1}`"  />
      </div>
      <p v-else-if="resolutions[i]?.resolution" class="mt-2 text-[13px] text-ok">
        {{ FLAG_RESOLUTION_LABELS[resolutions[i]!.resolution as FlagResolution['resolution']] }}<template v-if="resolutions[i]!.note"> — {{ resolutions[i]!.note }}</template>
      </p>
    </li>
  </ol>
</template>
