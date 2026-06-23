// src/core/enterprise/skill/local-store.ts
import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs'

const DIR = 'skills/enterprise'
const META = `${DIR}/.catalog.json`

export interface LocalCatalog {
  fetchedAt: number
  serverUrl: string                                 // help detect re-bind
  items: Array<{ id: string; name: string; latestVersion: string; latestVersionId: string }>
}

export async function ensureDir(): Promise<void> {
  await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => undefined)
}

export async function loadCatalog(): Promise<LocalCatalog | null> {
  if (!(await exists(META, { baseDir: BaseDirectory.AppData }))) return null
  try { return JSON.parse(await readTextFile(META, { baseDir: BaseDirectory.AppData })) as LocalCatalog }
  catch { return null }
}

export async function saveCatalog(c: LocalCatalog): Promise<void> {
  await ensureDir()
  await writeTextFile(META, JSON.stringify(c, null, 2), { baseDir: BaseDirectory.AppData })
}

/** Installed skill state — derived from filesystem entries. */
export interface InstalledSkill {
  name: string
  installedVersion: string
  path: string
}

export async function listInstalled(): Promise<InstalledSkill[]> {
  // For V1 we track install via a sidecar JSON; readDir not used to avoid Tauri perms complexity
  const idx = `${DIR}/.installed.json`
  if (!(await exists(idx, { baseDir: BaseDirectory.AppData }))) return []
  try { return JSON.parse(await readTextFile(idx, { baseDir: BaseDirectory.AppData })) as InstalledSkill[] }
  catch { return [] }
}

export async function setInstalled(rows: InstalledSkill[]): Promise<void> {
  await ensureDir()
  const idx = `${DIR}/.installed.json`
  await writeTextFile(idx, JSON.stringify(rows, null, 2), { baseDir: BaseDirectory.AppData })
}
