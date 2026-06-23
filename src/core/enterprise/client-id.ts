// src/core/enterprise/client-id.ts
import { exists, readTextFile, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'

const PATH = 'enterprise/client-id.txt'

function uuid(): string {
  // crypto.randomUUID is available in Tauri webview
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return (crypto as Crypto & { randomUUID(): string }).randomUUID()
  // fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export async function getOrCreateClientId(): Promise<string> {
  if (await exists(PATH, { baseDir: BaseDirectory.AppData })) {
    const txt = (await readTextFile(PATH, { baseDir: BaseDirectory.AppData })).trim()
    if (/^[0-9a-f-]{36}$/.test(txt)) return txt
  }
  const id = uuid()
  await writeTextFile(PATH, id, { baseDir: BaseDirectory.AppData })
  return id
}
