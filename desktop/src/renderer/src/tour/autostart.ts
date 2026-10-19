import { useExtrasStore } from '@renderer/stores/extras'
import { useSettingsStore } from '@renderer/stores/settings'

/** The tour is shown once: this is remembered in the settings table and mirrored per device. */
export const TOUR_SETTING = 'tour_done'
const LOCAL_KEY = 'mizaj.tour.done'

function localDone(): boolean {
  try {
    return localStorage.getItem(LOCAL_KEY) === '1'
  } catch {
    return false
  }
}

export const tourDone = (values: Record<string, string>): boolean =>
  values[TOUR_SETTING] === 'true' || localDone()

export function markTourDone(): void {
  try {
    localStorage.setItem(LOCAL_KEY, '1')
  } catch {
    /* storage unavailable: the setting below still remembers it */
  }
  void useSettingsStore()
    .update({ [TOUR_SETTING]: 'true' })
    .catch(() => {})
}

/** First run (not seen yet): start the tour. Test runs with an isolated profile opt out. */
export async function maybeStartTour(): Promise<void> {
  const settings = useSettingsStore()
  if (tourDone(settings.values)) return
  const flags = await window.mizajAPI?.getFlags?.().catch(() => null)
  if (flags && !flags.autoTour) return
  useExtrasStore().tourActive = true
}
