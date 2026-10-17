<script setup lang="ts">
const api = window.mizajAPI
</script>

<template>
  <header
    class="drag-region flex h-9 shrink-0 items-center justify-between bg-mizaj-slate px-3 text-slate-100"
    data-testid="titlebar"
  >
    <div class="flex items-center gap-2 font-bold">
      <span class="text-mizaj-emerald">مِزَاج</span>
      <span class="text-xs font-normal text-slate-400">استوديو التشكيل</span>
    </div>
    <div class="no-drag flex items-center gap-1" dir="ltr">
      <button
        class="h-7 w-9 rounded hover:bg-slate-700"
        aria-label="تصغير"
        data-testid="win-minimize"
        @click="api?.windowMinimize()"
      >
        &#8211;
      </button>
      <button
        class="h-7 w-9 rounded hover:bg-slate-700"
        aria-label="تكبير"
        data-testid="win-maximize"
        @click="api?.windowToggleMaximize()"
      >
        &#9633;
      </button>
      <button
        class="h-7 w-9 rounded hover:bg-red-600"
        aria-label="إغلاق"
        data-testid="win-close"
        @click="api?.windowClose()"
      >
        &#10005;
      </button>
    </div>
  </header>
</template>
