import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Open/close state of the lazily loaded extras: search across all files (Ctrl+Shift+F), print
 * preview (Ctrl+P) and the guided tour. The components themselves are separate chunks.
 */
export const useExtrasStore = defineStore('extras', () => {
  const searchOpen = ref(false)
  /** text to put in the search box when the panel opens */
  const searchSeed = ref('')
  const printOpen = ref(false)
  const tourActive = ref(false)
  /** the last session's tabs have been restored: the start screen may show (no flash at boot) */
  const shellReady = ref(false)
  function openSearch(seed = ''): void {
    searchSeed.value = seed
    searchOpen.value = true
  }
  return { searchOpen, searchSeed, printOpen, tourActive, shellReady, openSearch }
})
