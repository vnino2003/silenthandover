<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { IonButton, IonSpinner } from '@ionic/vue';

/** The app's button, built on Ionic's IonButton. A `to` makes it navigate like a link. */
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
const router = useRouter();
const link = computed(() => (props.to && !props.disabled ? router.resolve(props.to).fullPath : undefined));
const fill = computed(() => (props.variant === 'primary' ? 'solid' : props.variant === 'ghost' ? 'clear' : props.variant === 'danger' ? 'outline' : 'solid'));
const color = computed(() => (props.variant === 'danger' ? 'danger' : props.variant === 'primary' ? 'primary' : undefined));
</script>

<template>
  <IonButton
    :router-link="link"
    :type="type"
    :fill="fill"
    :color="color"
    :expand="block ? 'block' : undefined"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :class="[`sh-${size}`, `sh-${variant}`]"
  >
    <IonSpinner v-if="loading" slot="start" name="crescent" class="mr-2 size-4" aria-hidden="true" />
    <slot />
  </IonButton>
</template>
