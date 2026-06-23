/**
 * scanner.test.ts — unit tests for local personal data scanner.
 *
 * All Tauri APIs are globally mocked via src/test/setup.ts.
 * We override per-test with mockImplementation / mockResolvedValue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readDir, readTextFile, exists } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import { scanPersonalSkills, scanPersonalMemories, scanAll } from '../scanner'

const mockExists = vi.mocked(exists)
const mockReadDir = vi.mocked(readDir)
const mockReadTextFile = vi.mocked(readTextFile)
const mockHomeDir = vi.mocked(homeDir)

beforeEach(() => {
  vi.clearAllMocks()
  mockHomeDir.mockResolvedValue('/home/testuser')
})

// ── Helper types matching Tauri plugin-fs DirEntry ──
function dir(name: string) { return { name, isDirectory: true, isFile: false, isSymlink: false } as const }
function file(name: string) { return { name, isDirectory: false, isFile: true, isSymlink: false } as const }

describe('scanPersonalSkills', () => {
  it('returns skills that contain SKILL.md', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('/.abu/skills')) {
        return [dir('my-skill'), dir('no-skill-md'), dir('enterprise'), file('loose.txt')]
      }
      if (p.endsWith('/my-skill')) {
        return [file('SKILL.md'), file('manifest.json'), file('README.md')]
      }
      if (p.endsWith('/no-skill-md')) {
        return [file('README.md')]
      }
      return []
    })

    const result = await scanPersonalSkills()

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('my-skill')
    expect(result[0].hasSkillMd).toBe(true)
    expect(result[0].hasManifest).toBe(true)
    expect(result[0].files).toContain('SKILL.md')
  })

  it('skips the "enterprise" subdirectory', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('/.abu/skills')) {
        return [dir('enterprise'), dir('my-skill')]
      }
      if (p.endsWith('/my-skill')) return [file('SKILL.md')]
      if (p.endsWith('/enterprise')) return [file('SKILL.md')] // shouldn't be reached
      return []
    })

    const result = await scanPersonalSkills()
    expect(result.map(s => s.name)).not.toContain('enterprise')
    expect(result).toHaveLength(1)
  })

  it('returns empty array when skills dir does not exist', async () => {
    mockExists.mockResolvedValue(false)

    const result = await scanPersonalSkills()
    expect(result).toHaveLength(0)
  })

  it('handles skill with skill.md (lowercase) as valid', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('/.abu/skills')) return [dir('lower-skill')]
      if (p.endsWith('/lower-skill')) return [file('skill.md')]
      return []
    })

    const result = await scanPersonalSkills()
    expect(result).toHaveLength(1)
    expect(result[0].hasSkillMd).toBe(true)
    expect(result[0].hasManifest).toBe(false)
  })
})

describe('scanPersonalMemories', () => {
  it('returns .md files excluding MEMORY.md index', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockResolvedValue([
      file('project-notes.md'),
      file('feedback.md'),
      file('MEMORY.md'),    // index — should be excluded
      dir('subdir'),        // directory — skip
      file('image.png'),    // not .md — skip
    ])
    mockReadTextFile.mockResolvedValue('hello world')

    const result = await scanPersonalMemories()
    const names = result.map(m => m.filename).sort()
    expect(names).toEqual(['feedback.md', 'project-notes.md'])
    expect(result.every(m => m.sizeBytes > 0)).toBe(true)
  })

  it('returns empty array when memory dir does not exist', async () => {
    mockExists.mockResolvedValue(false)

    const result = await scanPersonalMemories()
    expect(result).toHaveLength(0)
  })

  it('includes entry even when file is unreadable (size=0)', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockResolvedValue([file('notes.md')])
    mockReadTextFile.mockRejectedValue(new Error('permission denied'))

    const result = await scanPersonalMemories()
    expect(result).toHaveLength(1)
    expect(result[0].sizeBytes).toBe(0)
  })
})

describe('scanAll', () => {
  it('returns both skills and memories', async () => {
    mockExists.mockResolvedValue(true)
    mockReadDir.mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('/.abu/skills')) return [dir('skill-a')]
      if (p.endsWith('/skill-a')) return [file('SKILL.md')]
      if (p.endsWith('/.abu/memory')) return [file('notes.md')]
      return []
    })
    mockReadTextFile.mockResolvedValue('content')

    const result = await scanAll()
    expect(result.skills).toHaveLength(1)
    expect(result.memories).toHaveLength(1)
  })

  it('handles missing dirs gracefully (both empty)', async () => {
    mockExists.mockResolvedValue(false)

    const result = await scanAll()
    expect(result.skills).toHaveLength(0)
    expect(result.memories).toHaveLength(0)
  })
})
