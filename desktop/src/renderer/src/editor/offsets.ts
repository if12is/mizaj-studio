/**
 * The backend reports legal-tool offsets in Unicode code points (Python str indices);
 * CodeMirror positions are UTF-16 code units. They differ after any astral character
 * (emoji, some symbols), so convert before touching the document.
 */
export function makeCpToUtf16(text: string): (cp: number) => number {
  if (!/[\uD800-\uDBFF]/.test(text)) return (cp) => Math.min(cp, text.length)
  const idx: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) continue // low surrogate: part of the previous code point
    idx.push(i + (c >= 0xd800 && c <= 0xdbff ? 2 : 1))
  }
  return (cp) => idx[Math.min(Math.max(cp, 0), idx.length - 1)]
}

export function cpToUtf16(text: string, cp: number): number {
  return makeCpToUtf16(text)(cp)
}
