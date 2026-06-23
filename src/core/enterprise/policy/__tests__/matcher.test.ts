// src/core/enterprise/policy/__tests__/matcher.test.ts
import { describe, it, expect } from 'vitest'
import { checkTool, checkSkill, checkMcp, checkFilePath } from '../matcher'
import type { EffectivePolicy } from '../types'

const empty: EffectivePolicy = {
  toolBlacklist: [],
  toolRequireConfirmation: [],
  skillBlacklist: [],
  mcpBlacklist: [],
  filePathAllowlist: [],
  filePathBlocklist: [],
}

describe('policy matcher', () => {
  describe('checkTool', () => {
    it('null policy allows', () => {
      expect(checkTool(null, 'bash', '').decision).toBe('allow')
    })

    it('blacklist entry without pattern denies any input', () => {
      expect(checkTool({ ...empty, toolBlacklist: [{ tool: 'bash' }] }, 'bash', 'ls').decision).toBe('deny')
    })

    it('blacklist entry with glob pattern only blocks matching input', () => {
      const policy: EffectivePolicy = { ...empty, toolBlacklist: [{ tool: 'bash', inputPattern: 'rm -rf*' }] }
      expect(checkTool(policy, 'bash', 'ls').decision).toBe('allow')
      expect(checkTool(policy, 'bash', 'rm -rf /tmp').decision).toBe('deny')
    })

    it('blacklist does not match different tool', () => {
      expect(checkTool({ ...empty, toolBlacklist: [{ tool: 'bash' }] }, 'write_file', 'x').decision).toBe('allow')
    })

    it('require_confirmation entry returns confirm', () => {
      expect(
        checkTool({ ...empty, toolRequireConfirmation: [{ tool: 'web_fetch' }] }, 'web_fetch', 'x').decision,
      ).toBe('confirm')
    })

    it('require_confirmation uses provided reason', () => {
      const r = checkTool(
        { ...empty, toolRequireConfirmation: [{ tool: 'bash', reason: 'sensitive' }] },
        'bash',
        'echo hi',
      )
      expect(r.decision).toBe('confirm')
      expect(r.reason).toBe('sensitive')
    })

    it('blacklist takes priority over require_confirmation', () => {
      const policy: EffectivePolicy = {
        ...empty,
        toolBlacklist: [{ tool: 'bash' }],
        toolRequireConfirmation: [{ tool: 'bash' }],
      }
      expect(checkTool(policy, 'bash', 'x').decision).toBe('deny')
    })
  })

  describe('checkSkill', () => {
    it('null policy allows', () => {
      expect(checkSkill(null, 'my-skill').decision).toBe('allow')
    })

    it('blacklist denies exact name', () => {
      expect(checkSkill({ ...empty, skillBlacklist: ['evil-skill'] }, 'evil-skill').decision).toBe('deny')
    })

    it('blacklist allows unlisted skills', () => {
      expect(checkSkill({ ...empty, skillBlacklist: ['evil-skill'] }, 'good-skill').decision).toBe('allow')
    })
  })

  describe('checkMcp', () => {
    it('null policy allows', () => {
      expect(checkMcp(null, 'my-server').decision).toBe('allow')
    })

    it('blacklist denies listed registry id', () => {
      expect(checkMcp({ ...empty, mcpBlacklist: ['bad-server'] }, 'bad-server').decision).toBe('deny')
    })

    it('blacklist allows unlisted server', () => {
      expect(checkMcp({ ...empty, mcpBlacklist: ['bad-server'] }, 'ok-server').decision).toBe('allow')
    })
  })

  describe('checkFilePath', () => {
    it('null policy allows', () => {
      expect(checkFilePath(null, '/etc/passwd').decision).toBe('allow')
    })

    it('blocklist denies paths with matching prefix', () => {
      expect(checkFilePath({ ...empty, filePathBlocklist: ['/etc'] }, '/etc/passwd').decision).toBe('deny')
    })

    it('blocklist does not deny unrelated paths', () => {
      expect(checkFilePath({ ...empty, filePathBlocklist: ['/etc'] }, '/home/user/doc.md').decision).toBe('allow')
    })

    it('allowlist denies paths outside it', () => {
      const policy: EffectivePolicy = { ...empty, filePathAllowlist: ['/home/user'] }
      expect(checkFilePath(policy, '/home/user/doc.md').decision).toBe('allow')
      expect(checkFilePath(policy, '/etc/passwd').decision).toBe('deny')
    })

    it('empty allowlist allows everything', () => {
      expect(checkFilePath({ ...empty }, '/etc/passwd').decision).toBe('allow')
    })

    it('blocklist checked before allowlist', () => {
      const policy: EffectivePolicy = {
        ...empty,
        filePathBlocklist: ['/home/user/secret'],
        filePathAllowlist: ['/home/user'],
      }
      expect(checkFilePath(policy, '/home/user/secret').decision).toBe('deny')
    })
  })
})
