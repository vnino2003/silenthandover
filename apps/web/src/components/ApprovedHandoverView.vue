<script setup lang="ts">
import SeverityTag from '@/components/ui/SeverityTag.vue';
import type { Decision } from '@/lib/types';

defineProps<{ content: NonNullable<Decision['approved_content']> }>();
</script>

<template>
  <div class="space-y-5">
    <p class="text-[15px] leading-relaxed whitespace-pre-wrap">{{ content.summary }}</p>

    <section v-if="content.unresolved_issues.length">
      <h4 class="eyebrow">Unresolved issues</h4>
      <ul class="mt-2 divide-y divide-line rounded-md border border-line">
        <li v-for="(i, n) in content.unresolved_issues" :key="n" class="px-3.5 py-2.5">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="text-[14px] font-medium">{{ i.title }}</span>
            <SeverityTag :severity="i.severity" :safety="i.is_safety_concern" />
            <span v-if="i.issue_code" class="text-[12.5px] text-ink-3 tnum">{{ i.issue_code }}</span>
            <span v-if="i.initial_status === 'pending_verification' && !i.link_issue_id" class="text-[12.5px] text-warn">Not yet verified</span>
          </div>
          <p v-if="i.description" class="mt-0.5 text-[14px] text-ink-2">{{ i.description }}</p>
        </li>
      </ul>
    </section>

    <section v-if="content.pending_actions.length">
      <h4 class="eyebrow">Tasks for the next shift</h4>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-[14px]">
        <li v-for="(a, n) in content.pending_actions" :key="n">
          {{ a.description }}<span v-if="a.issue_code" class="ml-2 text-[12.5px] text-ink-3 tnum">{{ a.issue_code }}</span>
        </li>
      </ul>
    </section>

    <section v-if="content.completed_tasks.length">
      <h4 class="eyebrow">Completed</h4>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-[14px] text-ink-2">
        <li v-for="(t, n) in content.completed_tasks" :key="n">{{ t.description }}</li>
      </ul>
    </section>

    <section v-if="content.notes_for_incoming">
      <h4 class="eyebrow">Notes</h4>
      <p class="mt-1 text-[14px] whitespace-pre-wrap">{{ content.notes_for_incoming }}</p>
    </section>
  </div>
</template>
