<script setup lang="ts">
import { computed, useId } from 'vue';
import type { MicaState } from '@/stores/mica';
const props = withDefaults(defineProps<{ size?: number; thinking?: boolean; mood?: 'idle' | 'welcome' | 'listening' | 'success'; animated?: boolean; state?: MicaState }>(), { size: 40, mood: 'idle', animated: false });
const uid = `folio-${useId()}`;
const pose = computed(() => props.state ?? (props.thinking ? 'processing' : props.mood === 'welcome' ? 'attentive' : props.mood === 'success' ? 'recorded' : props.mood === 'listening' ? 'listening' : 'ready'));
</script>
<template>
  <span aria-hidden="true" class="mica-mascot shrink-0" :class="[`mica-state-${pose}`, { 'mica-animated': animated || thinking }]" :style="{ width: `${size}px`, height: `${size}px`, '--mica-blink-delay': `${-(size % 7)}s` }">
    <svg class="mica-folio" viewBox="0 0 160 180" fill="none" focusable="false">
      <defs>
        <linearGradient :id="`${uid}-cover`" x1="20" y1="60" x2="132" y2="150" gradientUnits="userSpaceOnUse"><stop stop-color="#398c89"/><stop offset="1" stop-color="#175457"/></linearGradient>
        <linearGradient :id="`${uid}-paper`" x1="45" y1="24" x2="127" y2="142" gradientUnits="userSpaceOnUse"><stop stop-color="#fff9ee"/><stop offset="1" stop-color="#e4d8c4"/></linearGradient>
      </defs>
      <g class="folio-feet" fill="#245f60"><path d="M48 150h18l-1 14c-7 10-29 8-28 2 0-6 5-12 11-16Z"/><path d="M98 150h18l9 12c5 10-24 11-29 3Z"/></g>
      <g class="folio-core">
        <path d="M31 37Q25 24 43 21l67-8q13-1 15 14l6 110q1 14-14 15l-69 7q-19 0-19-18Z" fill="#1d6262"/>
        <g class="folio-pages">
          <path d="m48 29 59-18q11-3 14 10l11 115-70 12Z" fill="#d7cbb6"/>
          <path d="m47 32 73-10q13-2 13 12v106l-75 11Z" fill="#f4e9d5" stroke="#d9cbb5"/>
          <rect x="130" y="37" width="12" height="28" rx="4" fill="#2c7777"/>
          <path d="M39 39q0-10 12-11l65 2q12 0 12 13l-2 99q0 14-14 15H51q-14 0-14-14Z" :fill="`url(#${uid}-paper)`" stroke="#d9cbb5"/>
          <g class="folio-face" stroke="#35474a" stroke-linecap="round">
            <path class="folio-brow folio-brow-left" d="M65 55q4-3 8-1" stroke-width="2.4"/>
            <path class="folio-brow folio-brow-right" d="M101 55q4-2 8 1" stroke-width="2.4"/>
            <g class="folio-eyes" fill="#304346" stroke="none"><ellipse cx="69" cy="69" rx="3.7" ry="6"/><ellipse cx="105" cy="70" rx="3.7" ry="6"/><circle cx="70" cy="67" r="1" fill="#fff9ee"/><circle cx="106" cy="68" r="1" fill="#fff9ee"/></g>
            <path class="folio-mouth" d="M82 85q6 4 12 0" stroke-width="2"/>
          </g>
        </g>
        <path d="M31 30c-15 14-11 49-10 59 0 7 4 11 12 10l12 46q2 14 18 14h48q21-1 19-19c-2-21-35-40-58-55C47 67 31 47 31 30Z" :fill="`url(#${uid}-cover)`"/>
        <path d="M33 46c8 17 24 31 42 43 27 19 48 35 49 53" stroke="#65aaa2" stroke-opacity=".4" stroke-width="1.5"/>
        <g class="folio-hand folio-hand-left"><path d="M31 101c-12 1-16 20-10 27l12-3 8-17Z" fill="#2d7775"/><path d="M27 116c-9 0-10 12-4 16 4 4 13 2 15-3l-2-9Z" :fill="`url(#${uid}-paper)`"/></g>
        <g class="folio-hand folio-hand-right"><path d="M128 104c13 1 15 15 11 23l-11-3-7-13Z" fill="#236767"/><path d="M131 119c8-2 14 5 10 12-3 7-14 6-15-1l1-6" :fill="`url(#${uid}-paper)`"/></g>
      </g>
    </svg>
  </span>
</template>
