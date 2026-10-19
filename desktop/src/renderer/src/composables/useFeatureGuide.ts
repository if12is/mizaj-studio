import { nextTick } from 'vue'
import {
  FEATURES,
  locationText,
  type FeatureId,
  type FeatureInfo
} from '@renderer/features/registry'
import { showActionToast } from './useActionToast'
import { markFeatureNew } from './useNewFeatures'
import { spotlightElement } from './useSpotlight'
import { useSettingsStore } from '@renderer/stores/settings'

/** «أرني»: close settings, then point at the feature's button for ~3 s. */
export async function showFeature(id: FeatureId): Promise<boolean> {
  const f: FeatureInfo = FEATURES[id]
  useSettingsStore().closeSettings()
  await nextTick()
  // the settings dialog leaves with a short transition; the target sits underneath it
  await new Promise((r) => setTimeout(r, 250))
  return spotlightElement({ selector: f.selector, reveal: f.reveal, text: f.description })
}

/**
 * Call after enabling / installing a feature: «تم التفعيل» toast saying where it is, with «أرني»,
 * and a «جديد» badge on it until first use.
 */
export function announceFeature(id: FeatureId): void {
  const f: FeatureInfo = FEATURES[id]
  if (f.badge !== false) markFeatureNew(id)
  showActionToast({
    kind: 'success',
    title: `تم التفعيل: ${f.title}`,
    text: locationText(id),
    testid: `feature-toast-${id}`,
    actions: [
      { label: 'أرني', primary: true, testid: 'feature-show', run: () => void showFeature(id) }
    ]
  })
}
