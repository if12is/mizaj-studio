import { ref } from 'vue'
import type { FeatureId } from '@renderer/features/registry'

const KEY = 'mizaj.newFeatures'

function load(): FeatureId[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as FeatureId[]) : []
  } catch {
    return []
  }
}
function save(v: FeatureId[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    /* storage unavailable: badges just last for this session */
  }
}

/** Features enabled but not used yet: they carry the «جديد» badge. */
export const newFeatures = ref<FeatureId[]>(load())

export function markFeatureNew(id: FeatureId): void {
  if (newFeatures.value.includes(id)) return
  newFeatures.value = [...newFeatures.value, id]
  save(newFeatures.value)
}
export function markFeatureUsed(id: FeatureId): void {
  if (!newFeatures.value.includes(id)) return
  newFeatures.value = newFeatures.value.filter((x) => x !== id)
  save(newFeatures.value)
}
