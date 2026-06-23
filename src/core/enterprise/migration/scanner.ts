/**
 * scanner.ts — scan local personal skills and memories for migration.
 *
 * Skills:   ~/.abu/skills/  (personal user-installed skills; each subdir has SKILL.md)
 * Memories: ~/.abu/memory/  (global memdir; .md files, excluding MEMORY.md index)
 */

import { readDir, readTextFile, exists } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import { joinPath } from '@/utils/pathUtils'

// ── Path constants (relative to home) ──

const SKILLS_RELPATH = '.abu/skills'
const MEMORIES_RELPATH = '.abu/memory'

// ── Types ──

export interface PersonalSkillEntry {
  /** Skill directory name (used as slug). */
  name: string
  /** Absolute path to the skill directory. */
  path: string
  hasSkillMd: boolean
  hasManifest: boolean
  /** Shallow file list (non-directory entries, depth-1). */
  files: string[]
}

export interface PersonalMemoryEntry {
  filename: string
  /** Absolute path to the memory file. */
  path: string
  sizeBytes: number
}

export interface ScanResult {
  skills: PersonalSkillEntry[]
  memories: PersonalMemoryEntry[]
}

// ── Internal helpers ──

async function listDir(absPath: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
  if (!(await exists(absPath))) return []
  const entries = await readDir(absPath)
  return entries.map(e => ({ name: e.name ?? '', isDirectory: e.isDirectory ?? false }))
}

// ── Public API ──

/** Scan ~/.abu/skills/ and return entries that contain a SKILL.md. */
export async function scanPersonalSkills(): Promise<PersonalSkillEntry[]> {
  const home = await homeDir()
  const skillsDir = joinPath(home, SKILLS_RELPATH)

  const topLevel = await listDir(skillsDir)
  const out: PersonalSkillEntry[] = []

  for (const entry of topLevel) {
    if (!entry.isDirectory) continue
    if (!entry.name) continue
    // Skip enterprise-installed skills (they live under /enterprise/ and are already on-server)
    if (entry.name === 'enterprise') continue

    const skillPath = joinPath(skillsDir, entry.name)
    const inner = await listDir(skillPath)
    const files = inner.filter(e => !e.isDirectory).map(e => e.name)
    const hasSkillMd = files.some(f => f === 'SKILL.md' || f === 'skill.md')
    const hasManifest = files.some(f => f === 'manifest.json')

    if (!hasSkillMd) continue // Must have SKILL.md to be a valid skill

    out.push({ name: entry.name, path: skillPath, hasSkillMd, hasManifest, files })
  }

  return out
}

/** Scan ~/.abu/memory/ and return .md memory files (excluding MEMORY.md index). */
export async function scanPersonalMemories(): Promise<PersonalMemoryEntry[]> {
  const home = await homeDir()
  const memoriesDir = joinPath(home, MEMORIES_RELPATH)

  const entries = await listDir(memoriesDir)
  const out: PersonalMemoryEntry[] = []

  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.name.endsWith('.md')) continue
    // Exclude the MEMORY.md index file (it's the manifest, not a user memory)
    if (entry.name === 'MEMORY.md') continue

    const filePath = joinPath(memoriesDir, entry.name)
    let sizeBytes = 0
    try {
      const content = await readTextFile(filePath)
      sizeBytes = new TextEncoder().encode(content).length
    } catch {
      // File unreadable — still include the entry with size=0
    }

    out.push({ filename: entry.name, path: filePath, sizeBytes })
  }

  return out
}

/** Scan both skills and memories in parallel. */
export async function scanAll(): Promise<ScanResult> {
  const [skills, memories] = await Promise.all([scanPersonalSkills(), scanPersonalMemories()])
  return { skills, memories }
}
