// src/core/enterprise/__tests__/boot.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  BaseDirectory: { AppData: 'AppData' },
}))

describe('enterprise boot', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('loadBinding', () => {
    it('returns null when binding file does not exist', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      const { loadBinding } = await import('../boot')
      const result = await loadBinding()
      expect(result).toBeNull()
    })

    it('returns null when file has invalid JSON', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue('not-json')
      const { loadBinding } = await import('../boot')
      const result = await loadBinding()
      expect(result).toBeNull()
    })

    it('returns null when required fields are missing', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ serverUrl: 'https://x.com' }))
      const { loadBinding } = await import('../boot')
      const result = await loadBinding()
      expect(result).toBeNull()
    })

    it('returns the binding when file is valid', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      const binding = {
        serverUrl: 'https://abu.acme.com',
        orgId: 'org1',
        orgName: 'Acme',
        userId: 'u1',
        userName: 'Alice',
        userEmail: 'alice@acme.com',
        deptId: null,
        roleId: null,
        accessToken: 'tok123',
        boundAt: '2024-01-01T00:00:00Z',
      }
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(binding))
      const { loadBinding } = await import('../boot')
      const result = await loadBinding()
      expect(result).toEqual(binding)
    })
  })

  describe('saveBinding', () => {
    it('creates the enterprise AppData directory before the first write', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      const binding = {
        serverUrl: 'http://127.0.0.1:3000',
        orgId: 'org1',
        orgName: 'Acme',
        userId: 'u1',
        userName: 'Alice',
        userEmail: 'alice@acme.com',
        deptId: null,
        roleId: null,
        accessToken: 'access-token',
        boundAt: '2026-08-05T00:00:00Z',
      }
      const { saveBinding } = await import('../boot')

      await saveBinding(binding)

      expect(fs.mkdir).toHaveBeenCalledWith('enterprise', {
        baseDir: 'AppData',
        recursive: true,
      })
      expect(fs.writeTextFile).toHaveBeenCalledWith(
        'enterprise/binding.json',
        JSON.stringify(binding, null, 2),
        { baseDir: 'AppData' },
      )
      expect(vi.mocked(fs.mkdir).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(fs.writeTextFile).mock.invocationCallOrder[0])
    })
  })
})
