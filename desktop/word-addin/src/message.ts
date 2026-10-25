import { loadOffice } from './boot'
import { copyText } from './diag'
import './style.css'

/** The small dialog of the ribbon buttons: shows one status line and asks its parent to close it. */
const q = new URLSearchParams(location.search)
const text = (q.get('m') ?? '').slice(0, 600)
const error = q.get('e') === '1'
const box = document.getElementById('msg')
if (box) {
  box.textContent = text
  box.classList.toggle('mz-err', error)
}
const diagRaw = q.get('d')
const copyBtn = document.getElementById('copy-diag') as HTMLButtonElement | null
if (copyBtn && diagRaw) {
  copyBtn.hidden = false
  copyBtn.addEventListener('click', () => {
    void copyText(diagRaw).then((ok) => {
      copyBtn.textContent = ok ? 'نُسخت التفاصيل' : 'تعذّر النسخ'
    })
  })
}
void loadOffice()
  .then((o) => {
    const parent = (o as unknown as { context?: { ui?: { messageParent(m: string): void } } })
      .context?.ui
    setTimeout(() => parent?.messageParent('close'), diagRaw ? 30000 : error ? 7000 : 3500)
  })
  .catch(() => undefined)
