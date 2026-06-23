// src/core/enterprise/mcp/local-store.ts
import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs'

const PATH = 'enterprise/mcp.json'

export interface LocalMcpEntry {
  id: string                                   // mirror server id
  registryId: string
  name: string
  endpoint: string
  transportType: string
  credential: string                           // per-user scoped token from registry
  credentialExpiresAt: string                  // ISO
  addedAt: string
}

export async function loadInstalled(): Promise<LocalMcpEntry[]> {
  if (!(await exists(PATH, { baseDir: BaseDirectory.AppData }))) return []
  try { return JSON.parse(await readTextFile(PATH, { baseDir: BaseDirectory.AppData })) as LocalMcpEntry[] }
  catch { return [] }
}

export async function saveInstalled(entries: LocalMcpEntry[]): Promise<void> {
  await mkdir('enterprise', { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => undefined)
  await writeTextFile(PATH, JSON.stringify(entries, null, 2), { baseDir: BaseDirectory.AppData })
}
