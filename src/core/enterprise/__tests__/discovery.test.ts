// src/core/enterprise/__tests__/discovery.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  BaseDirectory: { AppData: 'AppData' },
}))

describe('enterprise discovery', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('parseEnrollDeepLink', () => {
    it('valid URL with server and token returns both fields', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      const result = parseEnrollDeepLink('abu://enroll?server=https://abu.acme.com&token=tok123')
      expect(result).toEqual({ serverUrl: 'https://abu.acme.com', enrollmentToken: 'tok123' })
    })

    it('valid URL with server only returns no enrollmentToken', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      const result = parseEnrollDeepLink('abu://enroll?server=https://abu.acme.com')
      expect(result).toEqual({ serverUrl: 'https://abu.acme.com' })
      expect(result?.enrollmentToken).toBeUndefined()
    })

    it('wrong scheme https:// returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('https://enroll?server=https://abu.acme.com')).toBeNull()
    })

    it('wrong scheme http:// returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('http://enroll?server=https://abu.acme.com')).toBeNull()
    })

    it('wrong host (abu://bind) returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('abu://bind?server=https://abu.acme.com')).toBeNull()
    })

    it('missing server param returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('abu://enroll?token=tok123')).toBeNull()
    })

    it('empty server param returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('abu://enroll?server=')).toBeNull()
    })

    it('completely empty string returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('')).toBeNull()
    })

    it('non-URL string "abc" returns null', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      expect(parseEnrollDeepLink('abc')).toBeNull()
    })

    it('server URL with encoded special chars parses correctly', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      const encoded = 'abu://enroll?server=https%3A%2F%2Fabu.acme.com%2Fenterprise&token=abc'
      const result = parseEnrollDeepLink(encoded)
      expect(result).toEqual({ serverUrl: 'https://abu.acme.com/enterprise', enrollmentToken: 'abc' })
    })

    it('server value that is not a valid URL itself is stored as-is (raw string)', async () => {
      const { parseEnrollDeepLink } = await import('../discovery')
      // We store the raw string — URL validation is the server's responsibility
      const result = parseEnrollDeepLink('abu://enroll?server=not-a-valid-url')
      expect(result).toEqual({ serverUrl: 'not-a-valid-url' })
    })
  })

  describe('resolveServerUrl', () => {
    it('with valid deepLinkUrl returns parsed result', async () => {
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl({ deepLinkUrl: 'abu://enroll?server=https://abu.acme.com' })
      expect(result).toEqual({ serverUrl: 'https://abu.acme.com' })
    })

    it('with valid deepLinkUrl that has token returns enrollmentToken', async () => {
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl({ deepLinkUrl: 'abu://enroll?server=https://abu.acme.com&token=tok999' })
      expect(result).toEqual({ serverUrl: 'https://abu.acme.com', enrollmentToken: 'tok999' })
    })

    it('with invalid deepLinkUrl falls through to binding', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
        serverUrl: 'https://fallback.acme.com',
        orgId: 'o1', orgName: 'Org', userId: 'u1',
        userName: 'Alice', userEmail: 'alice@acme.com',
        deptId: null, roleId: null, accessToken: 'tok',
        boundAt: '2024-01-01T00:00:00Z',
        llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
      }))
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl({ deepLinkUrl: 'not-a-deep-link' })
      expect(result).toEqual({ serverUrl: 'https://fallback.acme.com' })
    })

    it('with invalid deepLinkUrl and no binding returns null', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl({ deepLinkUrl: 'not-a-deep-link' })
      expect(result).toBeNull()
    })

    it('without deepLinkUrl, binding exists → returns serverUrl', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
      ;(fs.readTextFile as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({
        serverUrl: 'https://bound.acme.com',
        orgId: 'o2', orgName: 'BoundOrg', userId: 'u2',
        userName: 'Bob', userEmail: 'bob@acme.com',
        deptId: null, roleId: null, accessToken: 'tok2',
        boundAt: '2024-06-01T00:00:00Z',
        llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
      }))
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl()
      expect(result).toEqual({ serverUrl: 'https://bound.acme.com' })
    })

    it('without deepLinkUrl and no binding returns null', async () => {
      const fs = await import('@tauri-apps/plugin-fs')
      ;(fs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
      const { resolveServerUrl } = await import('../discovery')
      const result = await resolveServerUrl()
      expect(result).toBeNull()
    })
  })
})
