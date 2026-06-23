/**
 * migrator.ts — execute personal-to-enterprise data migration.
 *
 * Skills:   pack skill dir as zip (reuses packSkill pattern) → POST to enterprise admin API
 * Memories: read .md file → upload to employee's personal synced KB (auto-created)
 */

import { readTextFile } from '@tauri-apps/plugin-fs'
import { packSkill } from '@/core/skill/packager'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { createMyKb, uploadMyKbDoc, listMyKbs } from '@/core/enterprise/kb/personal-api'
import type { PersonalSkillEntry, PersonalMemoryEntry } from './scanner'

// ── Constants ──

const MEMORIES_KB_NAME = '我的记忆 (从个人版迁移)'

// ── Types ──

export interface MigrationProgress {
  step: 'starting' | 'skill' | 'memory' | 'done' | 'error'
  index: number
  total: number
  current?: string
  error?: string
}

export interface MigrationPlan {
  selectedSkills: PersonalSkillEntry[]
  selectedMemories: PersonalMemoryEntry[]
}

export interface MigrationItemResult {
  kind: 'skill' | 'memory'
  name: string
  ok: boolean
  error?: string
}

type ProgressCb = (p: MigrationProgress) => void

// ── Internal helpers ──

/** Upload a skill directory as zip to the enterprise admin endpoint. */
async function uploadSkillToEnterprise(s: PersonalSkillEntry): Promise<{ ok: boolean; error?: string }> {
  const mode = useEnterpriseStore.getState().mode
  if (mode.kind !== 'enterprise') return { ok: false, error: 'not in enterprise mode' }

  let zip: Uint8Array
  try {
    zip = await packSkill(s.path)
  } catch (e) {
    return { ok: false, error: `打包失败: ${(e as Error).message}` }
  }

  // Copy into a new Uint8Array backed by a plain ArrayBuffer (fflate returns ArrayBufferLike)
  const zipBuf = new Uint8Array(zip).buffer as ArrayBuffer
  const blob = new Blob([zipBuf], { type: 'application/zip' })
  const file = new File([blob], `${s.name}.zip`, { type: 'application/zip' })
  const form = new FormData()
  form.append('file', file)

  // POST to /api/admin/skills/packages — requires skill.publish permission.
  // Most employees won't have this permission and will get a 403 — surfaced as a
  // friendly message asking them to contact their admin.
  let res: Response
  try {
    res = await fetch(
      `${mode.binding.serverUrl.replace(/\/$/, '')}/api/admin/skills/packages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${mode.binding.accessToken}` },
        body: form,
      },
    )
  } catch (e) {
    return { ok: false, error: `网络错误: ${(e as Error).message}` }
  }

  if (res.status === 403) {
    return { ok: false, error: '需要管理员权限发布 Skill — 请将文件交给管理员上传' }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  }
  return { ok: true }
}

/** Ensure the "我的记忆" KB exists, returning its id. */
async function ensureMemoriesKb(): Promise<string> {
  const existing = await listMyKbs()
  const hit = existing.find(k => k.name === MEMORIES_KB_NAME)
  if (hit) return hit.id
  const created = await createMyKb({
    name: MEMORIES_KB_NAME,
    description: 'Auto-created during personal-to-enterprise migration',
  })
  return created.id
}

/** Upload a single memory .md file to the given KB. */
async function uploadMemoryToKb(kbId: string, m: PersonalMemoryEntry): Promise<{ ok: boolean; error?: string }> {
  try {
    const content = await readTextFile(m.path)
    const blob = new Blob([content], { type: 'text/markdown' })
    const file = new File([blob], m.filename, { type: 'text/markdown' })
    await uploadMyKbDoc(kbId, file)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ── Public API ──

/**
 * Execute the migration plan.
 * Skills are uploaded first, then memories (lazily creating the KB on first memory).
 */
export async function runMigration(
  plan: MigrationPlan,
  onProgress?: ProgressCb,
): Promise<MigrationItemResult[]> {
  const results: MigrationItemResult[] = []
  const total = plan.selectedSkills.length + plan.selectedMemories.length
  let i = 0

  onProgress?.({ step: 'starting', index: 0, total })

  // ── Skills ──
  for (const s of plan.selectedSkills) {
    i++
    onProgress?.({ step: 'skill', index: i, total, current: s.name })
    const r = await uploadSkillToEnterprise(s)
    results.push({ kind: 'skill', name: s.name, ok: r.ok, error: r.error })
  }

  // ── Memories (single KB, created lazily) ──
  let memKbId: string | null = null
  for (const m of plan.selectedMemories) {
    i++
    onProgress?.({ step: 'memory', index: i, total, current: m.filename })
    try {
      if (!memKbId) memKbId = await ensureMemoriesKb()
      const r = await uploadMemoryToKb(memKbId, m)
      results.push({ kind: 'memory', name: m.filename, ok: r.ok, error: r.error })
    } catch (e) {
      results.push({ kind: 'memory', name: m.filename, ok: false, error: (e as Error).message })
    }
  }

  onProgress?.({ step: 'done', index: total, total })
  return results
}

