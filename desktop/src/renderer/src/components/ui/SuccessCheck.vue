<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 18 })
</script>

<template>
  <svg
    class="m-check"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    data-testid="success-check"
  >
    <circle class="m-check-circle" cx="12" cy="12" r="10" />
    <path class="m-check-tick" d="M7.5 12.5l3 3 6-6.5" />
  </svg>
</template>
