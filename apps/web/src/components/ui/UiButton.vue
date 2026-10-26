<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    loading?: boolean;
    disabled?: boolean;
    to?: RouteLocationRaw;
    type?: 'button' | 'submit';
    block?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
);

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none',
  'transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out',
  // A slight press-down so every click feels acknowledged; not on disabled buttons.
  'active:scale-[0.97] disabled:active:scale-100',
  'disabled:cursor-not-allowed aria-disabled:cursor-not-allowed',
  props.block && 'w-full',
  {
    sm: 'h-8 px-3 text-[13px]',
    md: 'h-10 px-4 text-[14px]',
    lg: 'h-12 px-5 text-[15px]',
  }[props.size],
  {
    primary: 'bg-accent text-white shadow-[0_1px_2px_rgb(22_69_64/0.18)] hover:bg-accent-hover disabled:bg-line-strong disabled:text-ink-3 disabled:shadow-none',
    secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken disabled:text-ink-3 disabled:hover:bg-surface',
    ghost: 'text-ink-2 hover:bg-sunken hover:text-ink disabled:text-ink-3',
    danger: 'border border-bad/30 bg-surface text-bad hover:bg-bad-soft disabled:text-ink-3',
  }[props.variant],
]);
</script>

<template>
  <RouterLink v-if="to && !disabled" :to="to" :class="classes"><slot /></RouterLink>
  <button v-else :type="type" :class="classes" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <svg v-if="loading" class="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <slot />
  </button>
</template>
