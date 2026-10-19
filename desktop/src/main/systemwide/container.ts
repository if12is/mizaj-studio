/**
 * Binary container for clipboard snapshots exchanged with the Windows helper (winauto.ps1).
 * Layout (little endian):  "MZC1" | uint32 count | entries...
 * entry: int32 formatId | uint16 nameLen | name (UTF-8, registered formats only) | uint32 dataLen | data
 * The helper writes it (snapshot of every memory-based clipboard format) and reads it (restore).
 * JS only ever reads the text formats from it and builds a fresh one for the processed content.
 */
export interface ClipEntry {
  /** numeric clipboard format id (13 = CF_UNICODETEXT) */
  id: number
  /** registered format name, e.g. "HTML Format"; empty for standard formats */
  name: string
  data: Buffer
}

export const CF_TEXT = 1
export const CF_UNICODETEXT = 13
export const HTML_FORMAT = 'HTML Format'
const MAGIC = 'MZC1'

export function encodeContainer(entries: readonly ClipEntry[]): Buffer {
  const parts: Buffer[] = [Buffer.from(MAGIC, 'latin1')]
  const n = Buffer.alloc(4)
  n.writeUInt32LE(entries.length)
  parts.push(n)
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const head = Buffer.alloc(4 + 2)
    head.writeInt32LE(e.id, 0)
    head.writeUInt16LE(name.length, 4)
    const len = Buffer.alloc(4)
    len.writeUInt32LE(e.data.length)
    parts.push(head, name, len, e.data)
  }
  return Buffer.concat(parts)
}

/** Returns null for anything that is not a well-formed container (never throws on bad input). */
export function decodeContainer(buf: Buffer): ClipEntry[] | null {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== MAGIC) return null
  const count = buf.readUInt32LE(4)
  const out: ClipEntry[] = []
  let p = 8
  for (let i = 0; i < count; i++) {
    if (p + 6 > buf.length) return null
    const id = buf.readInt32LE(p)
    const nl = buf.readUInt16LE(p + 4)
    p += 6
    if (p + nl + 4 > buf.length) return null
    const name = buf.toString('utf8', p, p + nl)
    p += nl
    const dl = buf.readUInt32LE(p)
    p += 4
    if (p + dl > buf.length) return null
    out.push({ id, name, data: Buffer.from(buf.subarray(p, p + dl)) })
    p += dl
  }
  return out
}

/** UTF-16LE text with the terminating NUL Windows expects for CF_UNICODETEXT. */
export function unicodeTextEntry(text: string): ClipEntry {
  return { id: CF_UNICODETEXT, name: '', data: Buffer.from(text + '\0', 'utf16le') }
}

export function readUnicodeText(entries: readonly ClipEntry[]): string | null {
  const e = entries.find((x) => x.id === CF_UNICODETEXT && !x.name)
  if (!e) return null
  let end = e.data.length - (e.data.length % 2)
  while (end >= 2 && e.data[end - 2] === 0 && e.data[end - 1] === 0) end -= 2
  return e.data.toString('utf16le', 0, end)
}

export function readHtmlFormat(entries: readonly ClipEntry[]): Buffer | null {
  const e = entries.find((x) => x.name === HTML_FORMAT)
  return e ? e.data : null
}

/** Content to place on the clipboard: rich HTML (CF_HTML payload) when given, always plain text. */
export function contentContainer(plain: string, cfHtml?: Buffer): Buffer {
  const entries: ClipEntry[] = []
  if (cfHtml)
    entries.push({ id: 0, name: HTML_FORMAT, data: Buffer.concat([cfHtml, Buffer.from([0])]) })
  entries.push(unicodeTextEntry(plain))
  return encodeContainer(entries)
}
