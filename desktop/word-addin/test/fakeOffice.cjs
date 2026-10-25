/* eslint-disable */
/**
 * A FAKE Word document model + Office.js, for tests only (never shipped).
 * It implements the slice of the Word JS API the add-in calls, with the same asynchronous
 * semantics: reads need `load()` + `context.sync()` (reading an unloaded property throws, as the
 * real API does), writes are queued and applied at `sync()`, and a sync that carries writes counts
 * as one "write batch" (the unit Word turns into one undo entry, which the tests assert).
 *
 * The document is a list of paragraphs made of CELLS: one UTF-16 character each, with the
 * formatting of its run. That makes "were the runs preserved?" a precise question.
 *
 * Behaviour modelled after the real API (it can NOT replace testing in Word, see the guide):
 *   - insertText 'Replace': new text takes the formatting of the first replaced character;
 *   - insertText 'End' / 'Start': new text takes the formatting of the last / first character of
 *     the range and the range grows to include it; OTHER ranges ending at that point do not grow;
 *   - spec.skipWhitespaceInWildcard: '?' does not return whitespace characters at all;
 *   - getRange('Before'|'After'|'Start'|'End') gives a collapsed point, expandTo joins two of them;
 *   - search('?', {matchWildcards:true}) returns one range per character of the range, or, with
 *     spec.clusterMarks (what real Word does), one per letter together with its diacritics.
 *
 * Usable in Node (require) and in a browser page (addInitScript): it only assigns window globals
 * when a window exists.
 */
function createFakeWord(spec) {
  let nextId = 1
  const mkCell = (ch, fmt) => ({ id: nextId++, ch, fmt })
  const paras = spec.paragraphs.map((p) => ({
    cells: p.runs.flatMap((r) => r.t.split('').map((ch) => mkCell(ch, r.fmt || {}))),
    table: p.table || 0,
    fields: p.fields || 0,
    ccs: p.ccs || 0
  }))
  const stats = { writeBatches: 0, syncs: 0, writes: [] }
  const allRanges = []

  const idx = (pi, id) => paras[pi].cells.findIndex((c) => c.id === id)
  const fail = (m) => {
    throw new Error(m)
  }

  class Ctx {
    constructor() {
      this.pending = []
      this.writes = []
      this.document = { getSelection: () => mkSelection(this) }
    }
    async sync() {
      stats.syncs++
      const w = this.writes
      this.writes = []
      if (w.length) {
        stats.writeBatches++
        for (const f of w) f()
      }
      const p = this.pending
      this.pending = []
      for (const f of p) f()
    }
  }

  class Loadable {
    constructor(ctx) {
      this.ctx = ctx
      this._loaded = false
    }
    _need(name) {
      if (!this._loaded) fail(`PropertyNotLoaded: ${name}`)
    }
  }

  class Range extends Loadable {
    constructor(ctx, sp, sid, ep, eid) {
      super(ctx)
      this.sp = sp // start paragraph index
      this.sid = sid // start cell id (null: empty range)
      this.ep = ep
      this.eid = eid
      allRanges.push(this)
      this._text = null
    }
    _live() {
      if (this.sid == null) return ''
      const out = []
      for (let pi = this.sp; pi <= this.ep; pi++) {
        const cs = paras[pi].cells
        const a = pi === this.sp ? idx(pi, this.sid) : 0
        const b = pi === this.ep ? idx(pi, this.eid) : cs.length - 1
        if ((pi === this.sp && a < 0) || (pi === this.ep && b < 0)) fail('range boundary vanished')
        out.push(
          cs
            .slice(a, b + 1)
            .map((c) => c.ch)
            .join('')
        )
      }
      return out.join('\r')
    }
    get text() {
      this._need('text')
      return this._text
    }
    load() {
      this.ctx.pending.push(() => {
        this._loaded = true
        this._text = this._live()
      })
      return this
    }
    get paragraphs() {
      if (!this._paras) {
        this._paras = new Collection(this.ctx)
        this._paras._build = () => {
          const items = []
          for (let pi = this.sp; pi <= this.ep; pi++) items.push(new Paragraph(this.ctx, pi))
          return items
        }
      }
      return this._paras
    }
    getRange(loc) {
      if (loc === 'Start' || loc === 'End' || loc === 'Before' || loc === 'After') {
        // a collapsed point anchored to the first / last cell of this range
        const r = new Range(this.ctx, this.sp, null, this.sp, null)
        if (this.sid != null) {
          const first = loc === 'Start' || loc === 'Before'
          r.pt = { pi: first ? this.sp : this.ep, id: first ? this.sid : this.eid, before: first }
        }
        return r
      }
      return this
    }
    _bounds() {
      // [start, end) cell offsets inside one paragraph
      if (this.pt) {
        const i = idx(this.pt.pi, this.pt.id)
        if (i < 0) fail('range boundary vanished')
        const p = this.pt.before ? i : i + 1
        return { pi: this.pt.pi, s: p, e: p }
      }
      if (this.sid == null) fail('fake: expandTo on an empty range')
      if (this.sp !== this.ep) fail('fake: multi-paragraph expandTo')
      return { pi: this.sp, s: idx(this.sp, this.sid), e: idx(this.sp, this.eid) + 1 }
    }
    expandTo(o) {
      const x = this._bounds()
      const y = o._bounds()
      if (x.pi !== y.pi) fail('fake: expandTo across paragraphs')
      const s = Math.min(x.s, y.s)
      const e = Math.max(x.e, y.e)
      const cs = paras[x.pi].cells
      if (e <= s) return new Range(this.ctx, x.pi, null, x.pi, null)
      return new Range(this.ctx, x.pi, cs[s].id, x.pi, cs[e - 1].id)
    }
    intersectWith(o) {
      // absolute positions (paragraph, cell index)
      const s1 = this.sid == null ? null : [this.sp, idx(this.sp, this.sid)]
      const e1 = this.sid == null ? null : [this.ep, idx(this.ep, this.eid)]
      const s2 = o.sid == null ? null : [o.sp, idx(o.sp, o.sid)]
      const e2 = o.sid == null ? null : [o.ep, idx(o.ep, o.eid)]
      if (!s1 || !s2) fail('ItemNotFound')
      const cmp = (a, b) => a[0] - b[0] || a[1] - b[1]
      const s = cmp(s1, s2) >= 0 ? s1 : s2
      const e = cmp(e1, e2) <= 0 ? e1 : e2
      if (cmp(s, e) > 0) fail('ItemNotFound')
      return new Range(this.ctx, s[0], paras[s[0]].cells[s[1]].id, e[0], paras[e[0]].cells[e[1]].id)
    }
    search(text, opts) {
      if (text !== '?' || !opts || !opts.matchWildcards)
        fail('fake: only wildcard "?" search is modelled')
      const col = new Collection(this.ctx)
      col._build = () => {
        const items = []
        for (let pi = this.sp; pi <= this.ep; pi++) {
          const cs = paras[pi].cells
          const a = pi === this.sp ? idx(pi, this.sid) : 0
          const b = pi === this.ep ? idx(pi, this.eid) : cs.length - 1
          for (let i = a; i <= b; i++) {
            // real Word may not return spaces / tabs / NBSP for '?'
            if (spec.dropChars && spec.dropChars.includes(cs[i].ch)) continue
            if (spec.skipWhitespaceInWildcard && /\s/.test(cs[i].ch)) continue
            // real Word returns an Arabic letter TOGETHER with its diacritics as one match
            let j = i
            if (spec.clusterMarks)
              while (j + 1 <= b && /[\u064b-\u0652\u0670]/.test(cs[j + 1].ch)) j++
            items.push(new Range(this.ctx, pi, cs[i].id, pi, cs[j].id))
            i = j
          }
        }
        return items
      }
      return col
    }
    _replaceCells(newCells, keepFmtFrom) {
      // single-paragraph ranges only (all the add-in ever writes to)
      if (this.sp !== this.ep) fail('fake: multi-paragraph write')
      const pi = this.sp
      const cs = paras[pi].cells
      const a = idx(pi, this.sid)
      const b = idx(pi, this.eid)
      const removed = cs.slice(a, b + 1)
      const prev = a > 0 ? cs[a - 1] : null
      const next = b + 1 < cs.length ? cs[b + 1] : null
      cs.splice(a, b - a + 1, ...newCells)
      const ids = new Set(removed.map((c) => c.id))
      for (const r of allRanges) {
        if (r === this || r.sid == null) continue
        if (r.sp === pi && ids.has(r.sid)) {
          r.sid = newCells.length ? newCells[0].id : next ? next.id : null
          if (r.sid == null) r.eid = null
        }
        if (r.ep === pi && r.eid != null && ids.has(r.eid)) {
          r.eid = newCells.length ? newCells[newCells.length - 1].id : prev ? prev.id : null
          if (r.eid == null) r.sid = null
        }
      }
      if (newCells.length) {
        this.sid = newCells[0].id
        this.eid = newCells[newCells.length - 1].id
      } else {
        this.sid = null
        this.eid = null
      }
    }
    insertText(text, loc) {
      const out = new Range(this.ctx, this.sp, this.sid, this.ep, this.eid)
      this.ctx.writes.push(() => {
        stats.writes.push([loc, text])
        if (this.sid == null) fail('fake: insertText on an empty range')
        const pi = this.sp
        const cs = paras[pi].cells
        const a = idx(pi, this.sid)
        const b = idx(pi, this.eid)
        if (a < 0 || b < 0) fail('range boundary vanished')
        const mk = (fmtCell) => text.split('').map((ch) => mkCell(ch, fmtCell.fmt))
        if (loc === 'Replace') {
          this._replaceCells(mk(cs[a]))
        } else if (loc === 'End') {
          const n = mk(cs[b])
          cs.splice(b + 1, 0, ...n)
          if (n.length) this.eid = n[n.length - 1].id
        } else if (loc === 'Start') {
          const n = mk(cs[a])
          cs.splice(a, 0, ...n)
          if (n.length) this.sid = n[0].id
        } else fail('fake: location ' + loc)
      })
      return out
    }
    delete() {
      this.ctx.writes.push(() => {
        stats.writes.push(['Delete'])
        this._replaceCells([])
      })
    }
  }

  class Paragraph extends Loadable {
    constructor(ctx, pi) {
      super(ctx)
      this.pi = pi
      this._f = null
    }
    get text() {
      this._need('text')
      return this._f.text
    }
    get tableNestingLevel() {
      this._need('tableNestingLevel')
      return this._f.tbl
    }
    load() {
      this.ctx.pending.push(() => {
        this._loaded = true
        this._f = {
          text: paras[this.pi].cells.map((c) => c.ch).join('') + '\r',
          tbl: paras[this.pi].table
        }
      })
      return this
    }
    get fields() {
      if (!this._fields) {
        this._fields = new Collection(this.ctx)
        this._fields._build = () => Array.from({ length: paras[this.pi].fields }, () => ({}))
      }
      return this._fields
    }
    get contentControls() {
      if (!this._ccs) {
        this._ccs = new Collection(this.ctx)
        this._ccs._build = () => Array.from({ length: paras[this.pi].ccs }, () => ({}))
      }
      return this._ccs
    }
    getRange(loc) {
      const cs = paras[this.pi].cells
      if (loc !== 'Content' && loc !== 'Whole' && loc !== undefined)
        fail('fake: paragraph range ' + loc)
      if (!cs.length) return new Range(this.ctx, this.pi, null, this.pi, null)
      return new Range(this.ctx, this.pi, cs[0].id, this.pi, cs[cs.length - 1].id)
    }
  }

  class Collection extends Loadable {
    constructor(ctx) {
      super(ctx)
      this._items = null
    }
    get items() {
      this._need('items')
      return this._items
    }
    load(props) {
      this.ctx.pending.push(() => {
        this._loaded = true
        this._items = this._build()
        if (props && props.includes('/text'))
          for (const it of this._items) {
            it._loaded = true
            if (it._live) it._text = it._live()
          }
      })
      return this
    }
  }

  function mkSelection(ctx) {
    const s = spec.selection
    const a = paras[s.from.p].cells
    const b = paras[s.to.p].cells
    const sid = a[s.from.c] ? a[s.from.c].id : null
    const eid = s.to.c - 1 >= 0 && b[s.to.c - 1] ? b[s.to.c - 1].id : null
    if (sid == null) return new Range(ctx, s.from.p, null, s.to.p, null)
    return new Range(ctx, s.from.p, sid, s.to.p, eid)
  }

  const Word = {
    run: async (fn) => {
      const ctx = new Ctx()
      const r = await fn(ctx)
      await ctx.sync() // Word.run syncs implicitly at the end
      return r
    }
  }
  const Office = {
    __actions: {},
    onReady: (cb) => {
      const info = { host: 'Word', platform: 'PC' }
      if (cb) cb(info)
      return Promise.resolve(info)
    },
    context: { requirements: { isSetSupported: () => spec.supported !== false } },
    actions: {
      associate(name, fn) {
        Office.__actions[name] = fn
      }
    }
  }
  const getDoc = () =>
    paras.map((p) => {
      const runs = []
      for (const c of p.cells) {
        const last = runs[runs.length - 1]
        const key = JSON.stringify(c.fmt)
        if (last && last.key === key) last.t += c.ch
        else runs.push({ t: c.ch, fmt: c.fmt, key })
      }
      return runs.map(({ t, fmt }) => ({ t, fmt }))
    })
  return { Word, Office, getDoc, stats }
}

if (typeof window !== 'undefined') window.__createFakeWord = createFakeWord
if (typeof module !== 'undefined') module.exports = { createFakeWord }
