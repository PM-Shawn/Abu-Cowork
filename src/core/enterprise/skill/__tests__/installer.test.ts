// src/core/enterprise/skill/__tests__/installer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue('[]'),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  BaseDirectory: { AppData: 'AppData' },
}))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: {
    getState: () => ({
      mode: {
        kind: 'enterprise',
        binding: { serverUrl: 'http://x', accessToken: 't' },
      },
    }),
  },
}))

vi.mock('@/stores/enterpriseSkillStore', () => ({
  useEnterpriseSkillStore: { getState: () => ({ setInstalled: vi.fn() }) },
}))

vi.mock('@/core/enterprise/api', () => ({ callEnterprise: vi.fn().mockResolvedValue({}) }))

describe('installSkill', () => {
  beforeEach(() => vi.clearAllMocks())

  it('extracts and writes manifest.json and SKILL.md', async () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'demo', version: '1.0.0' })),
      'SKILL.md': strToU8('# Demo'),
    })
    const { fetch } = await import('@tauri-apps/plugin-http')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zip.buffer,
    })

    const { installSkill } = await import('../installer')
    await installSkill('pkg1', 'v1')

    const fs = await import('@tauri-apps/plugin-fs')
    const writtenPaths = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(writtenPaths.some(p => p.includes('manifest.json'))).toBe(true)
    expect(writtenPaths.some(p => p.includes('SKILL.md'))).toBe(true)
  })

  it('calls progress callbacks in order', async () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'demo', version: '1.0.0' })),
    })
    const { fetch } = await import('@tauri-apps/plugin-http')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zip.buffer,
    })

    const steps: string[] = []
    const { installSkill } = await import('../installer')
    await installSkill('pkg1', 'v1', p => steps.push(p.step))

    expect(steps).toEqual(['downloading', 'extracting', 'finalizing', 'done'])
  })

  it('rejects with SkillInstallError on download failure', async () => {
    const { fetch } = await import('@tauri-apps/plugin-http')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 403 })

    const { installSkill, SkillInstallError } = await import('../installer')
    await expect(installSkill('pkg1', 'v1')).rejects.toThrow(SkillInstallError)
  })

  it('rejects when manifest.json is missing from zip', async () => {
    const zip = zipSync({ 'SKILL.md': strToU8('# No manifest') })
    const { fetch } = await import('@tauri-apps/plugin-http')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => zip.buffer,
    })

    const { installSkill, SkillInstallError } = await import('../installer')
    await expect(installSkill('pkg1', 'v1')).rejects.toThrow(SkillInstallError)
  })
})

describe('uninstallSkill', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes directory and updates installed index', async () => {
    const fs = await import('@tauri-apps/plugin-fs')
    ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify([{ name: 'demo', installedVersion: '1.0.0', path: 'skills/enterprise/demo' }]),
    )

    const { uninstallSkill } = await import('../installer')
    await uninstallSkill('demo')

    expect(fs.remove).toHaveBeenCalled()
    const written = (fs.writeTextFile as ReturnType<typeof vi.fn>).mock.calls
    expect(written.length).toBeGreaterThan(0)
    const savedIndex = JSON.parse(written[written.length - 1][1] as string) as unknown[]
    expect(savedIndex).toHaveLength(0)
  })
})
