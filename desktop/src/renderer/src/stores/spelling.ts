import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { CATEGORY_LABELS, type SpellMark } from '@renderer/editor/spellModel'

export const useSpellingStore = defineStore('spelling', () => {
  const marks = shallowRef<SpellMark[]>([])
  const groups = computed(() =>
    Object.keys(CATEGORY_LABELS)
      .map((c) => ({
        category: c,
        label: CATEGORY_LABELS[c],
        items: marks.value.filter((m) => m.category === c)
      }))
      .filter((g) => g.items.length)
  )
  return { marks, groups }
})
