<script setup lang="ts">
// Mizaj mark (brand/logo-mark-dark.svg), split into animatable parts:
// body (the emerald nib/ink-drop), crown (amber shadda), nib (emerald fatha stroke), halo.
withDefaults(defineProps<{ size?: number; animated?: boolean; breathe?: boolean }>(), {
  size: 128,
  animated: true,
  breathe: false
})
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    :width="size"
    :height="size"
    class="m-mark"
    :class="[!animated && 'm-mark-static', breathe && 'm-mark-breathe']"
    aria-hidden="true"
    focusable="false"
    data-testid="brand-mark"
  >
    <defs>
      <radialGradient id="mizaj-mark-halo">
        <stop offset="0" stop-color="#F59E0B" stop-opacity=".32" />
        <stop offset=".6" stop-color="#F59E0B" stop-opacity=".1" />
        <stop offset="1" stop-color="#F59E0B" stop-opacity="0" />
      </radialGradient>
    </defs>
    <circle class="m-mark-halo" cx="256" cy="112" r="125" fill="url(#mizaj-mark-halo)" />
    <path
      class="m-mark-body"
      d="M256 196C274 252 342 290 364 350C368 364 364 376 352 388C334 408 322 438 318 476Q256 456 194 476C190 438 178 408 160 388C148 376 144 364 148 350C170 290 238 252 256 196ZM262 318A24 24 0 1 1 250 318L250 186L262 186Z"
      fill="#10B981"
      fill-rule="evenodd"
    />
    <path
      class="m-mark-crown"
      d="M158 166C162 108 208 98 227 154C238 104 274 104 285 154C304 98 350 108 354 166"
      fill="none"
      stroke="#F59E0B"
      stroke-width="27"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      class="m-mark-nib"
      d="M186 78L326 36"
      fill="none"
      stroke="#10B981"
      stroke-width="29"
      stroke-linecap="round"
    />
  </svg>
</template>
