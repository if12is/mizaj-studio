<script lang="ts">
/**
 * One consistent inline-SVG icon set (16px grid, 1.4 stroke, currentColor): no dependency,
 * themes with the text colour. Decorative by default (the button carries the label).
 */
export const ICON_PATHS = {
  tashkeel: 'M2 12.5h12M4 10l2-6 2 6M5 8h2.5M10.5 3.5l1 1.5 1-1.5',
  proofread: 'M2.5 8.5l3 3 8-8M2.5 13.5h11',
  spell: 'M2 12l3-8 3 8M3.2 9h3.6M10 12.5l1.8 1.8L15 10.5',
  find: 'M7 12a5 5 0 100-10 5 5 0 000 10zM10.8 10.8L14 14',
  color: 'M8 2.5C5 6 3.5 8 3.5 10a4.5 4.5 0 009 0c0-2-1.5-4-4.5-7.5z',
  page: 'M4 1.5h5.5L13 5v9.5H4zM9 1.5V5h4M6 8.5h5M6 11h5',
  diff: 'M5 2v12M11 2v12M2.5 5H5M11 11h2.5',
  stats: 'M3 13V8M7 13V3M11 13V6M14 13.5H2',
  export: 'M8 2v9M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11',
  import: 'M8 11V2M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11',
  folder: 'M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z',
  read: 'M3 6v4h2.5L9 13V3L5.5 6zM11.5 5.5a3.5 3.5 0 010 5',
  review:
    'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
  normalize: 'M2.5 4h11M2.5 8h11M2.5 12h11M5 2.5v3M11 6.5v3',
  poetry: 'M3 3h10M3 6h7M3 9h10M3 12h7',
  quality: 'M8 1.5l1.9 4 4.3.5-3.2 3 .9 4.3L8 11l-3.9 2.3.9-4.3-3.2-3 4.3-.5z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  legal: 'M8 2v12M3.5 14h9M3 4.5h10M3 4.5L1.5 9a2 2 0 003 0zM13 4.5L11.5 9a2 2 0 003 0z',
  gemini: 'M8 1.5C8.5 5 11 7.5 14.5 8 11 8.5 8.5 11 8 14.5 7.5 11 5 8.5 1.5 8 5 7.5 7.5 5 8 1.5z',
  sample: 'M4 1.5h5.5L13 5v9.5H4zM9 1.5V5h4M6.5 9h3M8 7.5v3',
  settings: 'M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7M10.5 3v3M5.5 10v3',
  help: 'M8 14a6 6 0 100-12 6 6 0 000 12zM6.3 6.3a1.8 1.8 0 113 1.3c-.7.5-1.3.9-1.3 1.7M8 11.5h.01',
  info: 'M8 14a6 6 0 100-12 6 6 0 000 12zM8 7.5v3.5M8 5h.01',
  check: 'M3 8.5l3.2 3.2L13 4.5',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  warn: 'M8 2L1.5 13.5h13zM8 6.5v3.5M8 12h.01',
  dock: 'M2 3h12v10H2zM2 9.5h12',
  collapse: 'M4 6l4 4 4-4',
  history: 'M2.5 8a5.5 5.5 0 105.5-5.5A5.6 5.6 0 004 4.3M2.5 2v3h3M8 5v3l2 1.5'
} as const
export type IconName = keyof typeof ICON_PATHS
</script>

<script setup lang="ts">
withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="shrink-0"
  >
    <path :d="ICON_PATHS[name]" />
  </svg>
</template>
