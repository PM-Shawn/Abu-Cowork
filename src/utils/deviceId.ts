/**
 * Anonymous analytics device id.
 *
 * Stays SYNCHRONOUS on purpose — five call sites read it inline. Durability
 * is handled one tier down instead: under Electron, preload.cjs reconciles
 * this localStorage key against a file in the app data dir BEFORE any renderer
 * module evaluates (see electron/deviceIdStore.cjs), so a reinstall or a
 * cleared Chromium profile no longer produces a brand-new id.
 *
 * The generate branch below is therefore a fallback — it runs only where no
 * Electron preload reconciled the value first (the Vite dev server, the frozen
 * Tauri shell) or if that reconciliation failed. An id minted here is promoted
 * into the file on the next Electron launch.
 */
const STORAGE_KEY = 'abu_device_id'

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY)
  if (!id) {
    id = generateId()
    localStorage.setItem(STORAGE_KEY, id)
  }
  return id
}
