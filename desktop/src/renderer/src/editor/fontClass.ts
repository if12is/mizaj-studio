export type DiacriticColor = 'emerald' | 'amber'

/**
 * Class for the editor host. Colored diacritics = COLR font + a named palette
 * (pure CSS). OFF = plain Amiri (same metrics, no reflow) because
 * `font-palette: normal` still paints palette 0 in Chromium.
 * The colored font only applies when the editor font is Amiri.
 */
export function editorPaletteClass(
  font: string,
  colored: boolean,
  color: string | undefined
): string {
  if (!colored || font !== 'Amiri') return 'pal-off'
  return color === 'amber' ? 'pal-amber' : 'pal-emerald'
}
