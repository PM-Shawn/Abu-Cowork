// src/core/enterprise/skill/installer.ts
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { writeFile, mkdir, exists, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { unzipSync, strFromU8 } from 'fflate'
import { callEnterprise } from '@/core/enterprise/api'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { useEnterpriseSkillStore } from '@/stores/enterpriseSkillStore'
import { setInstalled, listInstalled } from './local-store'

const ROOT = 'skills/enterprise'

export class SkillInstallError extends Error {
  step: 'download' | 'parse' | 'verify' | 'extract' | 'log'
  constructor(msg: string, step: 'download' | 'parse' | 'verify' | 'extract' | 'log') {
    super(msg)
    this.step = step
    this.name = 'SkillInstallError'
  }
}

async function downloadBytes(
  serverUrl: string,
  accessToken: string,
  pkgId: string,
  versionId: string,
): Promise<Uint8Array> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/skills/packages/${pkgId}/versions/${versionId}/download`
  const res = await tauriFetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new SkillInstallError(`HTTP ${res.status}`, 'download')
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

export interface InstallProgress {
  step: 'downloading' | 'extracting' | 'finalizing' | 'done'
  percent?: number
}

export async function installSkill(
  pkgId: string,
  versionId: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  const m = useEnterpriseStore.getState().mode
  if (m.kind !== 'enterprise') throw new SkillInstallError('not in enterprise mode', 'download')
  const binding = m.binding

  onProgress?.({ step: 'downloading' })
  const bytes = await downloadBytes(binding.serverUrl, binding.accessToken, pkgId, versionId)

  // V1: signature verify skipped if pubkey not configured — deferred to V1.5
  // when server will provide a separate manifest endpoint with signature.

  onProgress?.({ step: 'extracting' })
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    throw new SkillInstallError((e as Error).message, 'extract')
  }

  const manifestRaw = entries['manifest.json']
  if (!manifestRaw) throw new SkillInstallError('manifest.json missing', 'parse')
  let manifest: { name: string; version: string }
  try {
    manifest = JSON.parse(strFromU8(manifestRaw)) as { name: string; version: string }
  } catch {
    throw new SkillInstallError('manifest.json invalid', 'parse')
  }

  const safeName = manifest.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  const targetDir = `${ROOT}/${safeName}`

  // Wipe existing dir (V1 simple overwrite; V1.5: atomic swap)
  if (await exists(targetDir, { baseDir: BaseDirectory.AppData })) {
    await remove(targetDir, { baseDir: BaseDirectory.AppData, recursive: true })
  }
  await mkdir(targetDir, { baseDir: BaseDirectory.AppData, recursive: true })

  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith('/')) continue
    if (entryPath.includes('..')) continue // path traversal safety
    const fullPath = `${targetDir}/${entryPath}`
    const parentIdx = fullPath.lastIndexOf('/')
    if (parentIdx > 0) {
      await mkdir(fullPath.slice(0, parentIdx), { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => undefined)
    }
    await writeFile(fullPath, data, { baseDir: BaseDirectory.AppData })
  }

  onProgress?.({ step: 'finalizing' })

  // Update local installed index
  const current = await listInstalled()
  const next = [
    ...current.filter(x => x.name !== manifest.name),
    { name: manifest.name, installedVersion: manifest.version, path: targetDir },
  ]
  await setInstalled(next)
  useEnterpriseSkillStore.getState().setInstalled(next)

  // Notify server (best-effort — do not fail install if this errors)
  try {
    await callEnterprise(`/api/skills/packages/${pkgId}/install`, {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    })
  } catch { /* tolerate */ }

  onProgress?.({ step: 'done' })
}

export async function uninstallSkill(name: string): Promise<void> {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  const targetDir = `${ROOT}/${safeName}`
  if (await exists(targetDir, { baseDir: BaseDirectory.AppData })) {
    await remove(targetDir, { baseDir: BaseDirectory.AppData, recursive: true })
  }
  const current = await listInstalled()
  const next = current.filter(x => x.name !== name)
  await setInstalled(next)
  useEnterpriseSkillStore.getState().setInstalled(next)
}
