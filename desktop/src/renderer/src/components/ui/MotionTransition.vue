<script setup lang="ts">
import { useReducedMotion } from '@renderer/lib/motion'

// <Transition> preset wrapper (see assets/motion.css). Under prefers-reduced-motion the CSS
// classes are not applied at all, so elements enter/leave instantly (no 1-frame lingering).
defineProps<{ name: string; mode?: 'out-in' | 'in-out'; appear?: boolean }>()
const reduced = useReducedMotion()
</script>

<template>
  <Transition :name="name" :mode="mode" :appear="appear" :css="!reduced">
    <slot />
  </Transition>
</template>
