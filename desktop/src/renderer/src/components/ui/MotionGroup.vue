<script setup lang="ts">
import { useReducedMotion } from '@renderer/lib/motion'

// <TransitionGroup> preset wrapper; attrs (class, role, data-testid) land on the group element.
defineProps<{ name: string; tag?: string }>()
const reduced = useReducedMotion()
</script>

<template>
  <TransitionGroup :name="name" :tag="tag ?? 'div'" :css="!reduced">
    <slot />
  </TransitionGroup>
</template>
