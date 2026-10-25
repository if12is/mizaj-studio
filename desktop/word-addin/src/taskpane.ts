import type { OpId } from './api'
import { AddinApiError, APP_DOWN_AR } from './api'
import { createBoot, loadOffice, readPairing, registerServiceWorker, type Boot } from './boot'
import { copyText, diagJson, type Diagnostics } from './diag'
import { OP_LABEL_AR, diagnosticsOfError, messageOf, type Preview } from './run'
import './style.css'

/**
 * Task pane: choose an operation, see the preview (changed words old/new), then «استبدال».
 * All text is rendered with textContent / text nodes only (never innerHTML).
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const token = readPairing()
registerServiceWorker()

let boot: Boot | null = null
let current: Preview | null = null
let busy = false
let diag: Diagnostics | null = null

function setDiag(d: Diagnostics | null): void {
  diag = d
  $<HTMLButtonElement>('copy-diag').hidden = !d
}

function setStatus(text: string, error = false): void {
  const s = $('status')
  s.textContent = text
  s.classList.toggle('mz-err', error)
}

function setConn(state: 'ok' | 'wait' | 'down'): void {
  const c = $('conn')
  c.dataset.state = state
  c.textContent = state === 'ok' ? 'متصل بمِزَاج' : state === 'wait' ? 'المحرك يستعد…' : 'غير متصل'
  const b = $('banner')
  b.hidden = state !== 'down'
  if (state === 'down') b.textContent = APP_DOWN_AR
}

function setBusy(v: boolean): void {
  busy = v
  for (const el of document.querySelectorAll<HTMLButtonElement>('.mz-ops button')) el.disabled = v
  if (v) $<HTMLButtonElement>('apply').disabled = true
}

async function ping(): Promise<void> {
  if (!boot) return
  try {
    const r = await boot.api.ping()
    setConn(r.engine ? 'ok' : 'wait')
    if ($('banner').dataset.kind === 'pair') $('banner').hidden = true
  } catch (e) {
    if (e instanceof AddinApiError && e.code === 'not_paired') {
      setConn('down')
      $('banner').textContent = e.messageAr
      $('banner').dataset.kind = 'pair'
    } else setConn('down')
  }
}

function renderPreview(p: Preview): void {
  $('result').hidden = false
  $('result-title').textContent = OP_LABEL_AR[p.op]
  const box = $('preview')
  box.replaceChildren()
  if (!p.changed) {
    box.textContent = 'لا توجد تغييرات: النص سليم كما هو.'
  } else {
    for (const s of p.segments) {
      if (s.kind === 'same') box.append(document.createTextNode(s.text))
      else {
        const del = document.createElement('del')
        del.textContent = s.old ?? ''
        const ins = document.createElement('ins')
        ins.textContent = s.text
        ins.className = s.letters ? 'mz-letters' : ''
        box.append(del, document.createTextNode(' '), ins)
      }
    }
  }
  const notes = $('notes')
  notes.replaceChildren()
  const add = (t: string): void => {
    const li = document.createElement('li')
    li.textContent = t
    notes.append(li)
  }
  for (const w of p.warnings) add(w)
  const skipped =
    Object.values(p.skipped).reduce((a, b) => a + (b ?? 0), 0) - (p.skipped.empty ?? 0)
  if (skipped > 0) add(`ستُترك ${skipped} فقرة تحتوي حقولاً أو عناصر تحكم كما هي.`)
  $<HTMLButtonElement>('apply').disabled = !p.changed
}

async function startOp(op: OpId): Promise<void> {
  if (!boot || busy) return
  setBusy(true)
  current = null
  setStatus('جارٍ المعالجة…')
  try {
    setDiag(null)
    current = await boot.runner.preview(op)
    renderPreview(current)
    setStatus(current.changed ? 'راجع التغييرات ثم اضغط «استبدال».' : '')
  } catch (e) {
    $('result').hidden = true
    setDiag(diagnosticsOfError(op, e))
    setStatus(messageOf(e), true)
    if (e instanceof AddinApiError && e.code === 'app_down') setConn('down')
  } finally {
    setBusy(false)
    $<HTMLButtonElement>('apply').disabled = !(current && current.changed)
  }
}

async function doApply(): Promise<void> {
  if (!boot || !current || busy) return
  setBusy(true)
  setStatus('جارٍ الاستبدال…')
  try {
    const out = await boot.runner.apply(current)
    setDiag(out.diagnostics)
    setStatus(out.messages.join(' '), out.report.verifyFailed || out.report.unmapped > 0)
    current = null
    $('result').hidden = true
  } catch (e) {
    setDiag(diagnosticsOfError(current?.op ?? 'all', e))
    setStatus(messageOf(e), true)
  } finally {
    setBusy(false)
    $<HTMLButtonElement>('apply').disabled = true
  }
}

function cancel(): void {
  current = null
  $('result').hidden = true
  setStatus('')
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.mz-ops button'))
  b.addEventListener('click', () => void startOp(b.dataset.op as OpId))
$('apply').addEventListener('click', () => void doApply())
$('cancel').addEventListener('click', cancel)
$('copy-diag').addEventListener('click', () => {
  if (!diag) return
  void copyText(diagJson(diag)).then((ok) =>
    setStatus(ok ? 'نُسخت التفاصيل (أرقام فقط، دون نص مستندك).' : 'تعذّر النسخ.')
  )
})

void loadOffice()
  .then((office) => {
    boot = createBoot(office, token)
    void ping()
    setInterval(() => void ping(), 4000)
  })
  .catch(() => {
    setConn('down')
    $('banner').textContent =
      'تعذّر تحميل مكتبة Office.js. تحتاج الإضافة اتصالاً بالإنترنت في أول تشغيل فقط (انظر الدليل).'
  })
