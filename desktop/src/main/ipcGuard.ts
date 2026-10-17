import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl, type AppLocation } from './security'

/**
 * Every IPC entry point validates that the message comes from the app's own top-level page
 * (file:// index.html or the dev server), never from a sub-frame or a foreign page.
 */

let location: AppLocation | null = null
let warn: (...a: unknown[]) => void = () => {}

export function configureIpcGuard(loc: AppLocation, logWarn: (...a: unknown[]) => void): void {
  location = loc
  warn = logWarn
}

type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'senderFrame'>

export function isTrustedSender(e: SenderEvent): boolean {
  const f = e.senderFrame
  if (!f || !location) return false
  if (f.parent) return false // sub-frames are never trusted
  return isAppUrl(f.url, location)
}

export function handleSecure(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!isTrustedSender(e)) {
      warn(`ipc: rejected '${channel}' from untrusted frame`)
      throw new Error('untrusted IPC sender')
    }
    return fn(e, ...args)
  })
}

export function onSecure(
  channel: string,
  fn: (e: IpcMainEvent, ...args: any[]) => void // eslint-disable-line @typescript-eslint/no-explicit-any
): void {
  ipcMain.on(channel, (e, ...args) => {
    if (!isTrustedSender(e)) {
      warn(`ipc: rejected '${channel}' from untrusted frame`)
      return
    }
    fn(e, ...args)
  })
}
