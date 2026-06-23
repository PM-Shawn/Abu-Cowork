// src/core/enterprise/__tests__/client-id.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Tauri APIs not available in vitest; mock the file store
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  BaseDirectory: { AppData: 'AppData' },
}))

describe('client id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('generates uuid format', async () => {
    const fs = await import('@tauri-apps/plugin-fs')
    ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    ;(fs.writeTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const { getOrCreateClientId } = await import('../client-id')
    const id = await getOrCreateClientId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reuses existing id', async () => {
    const fs = await import('@tauri-apps/plugin-fs')
    ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    const { getOrCreateClientId } = await import('../client-id')
    const id = await getOrCreateClientId()
    expect(id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  })
})
