import type { OpId } from './api'
import { createBoot, loadOffice, readPairing, registerServiceWorker } from './boot'
import { messageOf } from './run'

/**
 * Function file of the ribbon: the four buttons run one operation on the selection straight away
 * (no preview). Word gives a function command no UI of its own, so the outcome is shown in a small
 * Office dialog (message.html) that closes itself; the text is also put in #status for tests.
 */

const token = readPairing()
registerServiceWorker()

type Event = { completed(): void }
const OPS: Record<string, OpId> = {
  mizajProofread: 'proofread',
  mizajPunctuation: 'punctuation',
  mizajTashkeel: 'tashkeel',
  mizajAll: 'all'
}

interface DialogApi {
  displayDialogAsync(
    url: string,
    opts: Record<string, unknown>,
    cb: (r: {
      status: string
      value: { close(): void; addEventHandlerAsync(t: unknown, h: () => void): void }
    }) => void
  ): void
}

function notify(text: string, error: boolean): void {
  const el = document.getElementById('status')
  if (el) el.textContent = text
  try {
    const ui = window.Office as unknown as {
      context?: { ui?: DialogApi }
      EventType?: { DialogMessageReceived: unknown }
    }
    const url = `${location.origin}/message.html?e=${error ? 1 : 0}&m=${encodeURIComponent(text)}`
    ui.context?.ui?.displayDialogAsync(
      url,
      { height: 22, width: 28, displayInIframe: true },
      (r) => {
        if (r.status !== 'succeeded') return
        r.value.addEventHandlerAsync(ui.EventType?.DialogMessageReceived, () => r.value.close())
      }
    )
  } catch {
    /* no dialog support: the user simply sees the change (or not) in the document */
  }
}

void loadOffice()
  .then((office) => {
    const boot = createBoot(office, token)
    for (const [fn, op] of Object.entries(OPS)) {
      office.actions?.associate(fn, async (event: Event) => {
        try {
          const { outcome } = await boot.runner.runDirect(op)
          notify(outcome.messages.join(' '), outcome.report.verifyFailed)
        } catch (e) {
          notify(messageOf(e), true)
        }
        event.completed()
      })
    }
  })
  .catch(() => undefined)
