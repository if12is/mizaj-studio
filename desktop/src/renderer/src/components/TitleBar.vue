<script setup lang="ts">
import BrandMark from './ui/BrandMark.vue'
const api = window.mizajAPI

// Physical order from the far left edge (RTL window): close, maximize, minimize.
// The container is dir="ltr" so DOM order == visual order, whatever the page direction.
const btn =
  'group flex h-7 w-10 items-center justify-center rounded text-slate-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald'
</script>

<template>
  <header
    class="drag-region flex h-9 shrink-0 items-center justify-between bg-mizaj-slate px-3 text-slate-100"
    data-testid="titlebar"
  >
    <div class="flex items-center gap-2 font-bold">
      <BrandMark :size="22" :animated="false" />
      <span class="text-mizaj-emerald">مِزَاج</span>
      <span class="text-xs font-normal text-slate-400">استوديو التشكيل</span>
    </div>
    <div class="no-drag flex items-center gap-1" dir="ltr" data-testid="window-controls">
      <button
        :class="[btn, 'bg-red-500/10 text-red-300 hover:bg-red-600 hover:text-white']"
        aria-label="إغلاق"
        title="إغلاق (Alt+F4)"
        data-testid="win-close"
        @click="api?.windowClose()"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" fill="none" />
        </svg>
      </button>
      <button
        :class="[btn, 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/30']"
        aria-label="تكبير"
        title="تكبير / استعادة"
        data-testid="win-maximize"
        @click="api?.windowToggleMaximize()"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect
            x="2"
            y="2"
            width="8"
            height="8"
            rx="1"
            stroke="currentColor"
            stroke-width="1.5"
            fill="none"
          />
        </svg>
      </button>
      <button
        :class="[btn, 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/30']"
        aria-label="تصغير"
        title="تصغير"
        data-testid="win-minimize"
        @click="api?.windowMinimize()"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 9h8" stroke="currentColor" stroke-width="1.5" fill="none" />
        </svg>
      </button>
    </div>
  </header>
</template>
