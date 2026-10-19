import { useApi } from '@renderer/api'

/** `GET /api/search`: full-text search over every document (backend/app/core/search.py). */
export interface ContentSnippet {
  /** where the match starts in the document, in editor offsets */
  offset: number
  text: string
  /** highlighted [start, end) ranges inside `text` */
  ranges: [number, number][]
}
export interface ContentResult {
  document_id: number
  project_id: number
  project_name: string
  title: string
  title_ranges: [number, number][]
  updated_at: string
  match_count: number
  snippets: ContentSnippet[]
}
export interface ContentResponse {
  query: string
  total: number
  results: ContentResult[]
}

/** Fewer than two letters is never searched (the backend agrees). */
export const MIN_QUERY = 2

export async function searchContent(
  q: string,
  opts: { limit?: number; snippets?: number } = {}
): Promise<ContentResponse> {
  const p = new URLSearchParams({
    q,
    limit: String(opts.limit ?? 30),
    snippets: String(opts.snippets ?? 3)
  })
  return useApi().get<ContentResponse>(`/api/search?${p}`, true)
}

export interface Part {
  text: string
  mark: boolean
}

/** Split `text` into plain / highlighted parts (safe to render with v-for, no v-html). */
export function highlightParts(text: string, ranges: [number, number][]): Part[] {
  const out: Part[] = []
  let at = 0
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const s = Math.max(a, at)
    const e = Math.min(b, text.length)
    if (e <= s) continue
    if (s > at) out.push({ text: text.slice(at, s), mark: false })
    out.push({ text: text.slice(s, e), mark: true })
    at = e
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false })
  return out
}
