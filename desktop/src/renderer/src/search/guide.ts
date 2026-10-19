import { shallowRef } from 'vue'
import type { GuideTopic } from './entries'

/**
 * Guide / help topics searchable from the palette. The app has no in-app guide yet; whoever adds
 * one registers its topics here and they appear in the palette under «الدليل» automatically.
 */
const topics = shallowRef<GuideTopic[]>([])

export function registerGuideTopics(list: GuideTopic[]): () => void {
  topics.value = [...topics.value.filter((t) => !list.some((n) => n.id === t.id)), ...list]
  return () => (topics.value = topics.value.filter((t) => !list.some((n) => n.id === t.id)))
}
export const listGuideTopics = (): GuideTopic[] => topics.value
