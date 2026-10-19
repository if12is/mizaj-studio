import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Open/close state of the global search / command palette (Ctrl+K, Ctrl+Shift+P). */
export const usePaletteStore = defineStore('palette', () => {
  const open = ref(false)
  function show(): void {
    open.value = true
  }
  function hide(): void {
    open.value = false
  }
  function toggle(): void {
    open.value = !open.value
  }
  return { open, show, hide, toggle }
})
