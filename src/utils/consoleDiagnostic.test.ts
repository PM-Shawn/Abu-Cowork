import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CheckResult } from '@/core/diagnostic/types'

// vi.mock is hoisted before variable declarations, so use vi.hoisted() to
// declare the spy before the factory runs.
const mockGetState = vi.hoisted(() => vi.fn())

// Mock the store so the module under test sees our controlled state,
// regardless of what VITE_CONSOLE_URL is set to in .env.local.
vi.mock('@/stores/diagnosticStore', () => ({
  useDiagnosticStore: { getState: mockGetState },
  getOverallStatus: (s: { isChecking: boolean; results: Record<string, CheckResult> }) => {
    if (s.isChecking) return 'checking'
    const arr = Object.values(s.results)
    if (arr.length === 0) return 'no-data'
    if (arr.some((r) => r.status === 'failed')) return 'has-failures'
    if (arr.some((r) => r.status === 'warning')) return 'has-warnings'
    return 'all-passed'
  },
}))

// Import after mocks are in place
import { pushDiagnosticSnapshot } from './consoleDiagnostic'

// ── fixtures ────────────────────────────────────────────────────────────────

const PASSED: CheckResult = {
  id: 'network:reachability',
  category: 'network',
  name: '网络可达性',
  status: 'passed',
  metric: '200ms',
  checkedAt: 1_000_000,
  durationMs: 200,
}

const FAILED: CheckResult = {
  id: 'ai-services:anthropic-1',
  category: 'ai-services',
  name: 'Anthropic',
  status: 'failed',
  errorMessage: 'API Key 未配置',
  checkedAt: 1_000_000,
  durationMs: 50,
}

function makeState(results: CheckResult[], isChecking = false, lastCheckedAt: number | null = 1_000_000) {
  return {
    results: Object.fromEntries(results.map((r) => [r.id, r])),
    isChecking,
    lastCheckedAt,
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// ── guard conditions ─────────────────────────────────────────────────────────

describe('pushDiagnosticSnapshot', () => {
  describe('guard: empty results', () => {
    it('does not call fetch when results are empty', () => {
      mockGetState.mockReturnValue(makeState([]))
      pushDiagnosticSnapshot()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('guard: isChecking', () => {
    it('does not call fetch while checks are still running', () => {
      mockGetState.mockReturnValue(makeState([PASSED], /* isChecking= */ true))
      pushDiagnosticSnapshot()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('happy path', () => {
    it('calls the correct endpoint', () => {
      mockGetState.mockReturnValue(makeState([PASSED]))
      pushDiagnosticSnapshot()
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
      expect(url).toMatch(/\/api\/diagnostic$/)
    })

    it('sends overall = all-passed when all results pass', () => {
      mockGetState.mockReturnValue(makeState([PASSED]))
      pushDiagnosticSnapshot()
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.overall).toBe('all-passed')
    })

    it('sends overall = has-failures when any result failed', () => {
      mockGetState.mockReturnValue(makeState([PASSED, FAILED]))
      pushDiagnosticSnapshot()
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.overall).toBe('has-failures')
    })

    it('sends all results in the payload', () => {
      mockGetState.mockReturnValue(makeState([PASSED, FAILED]))
      pushDiagnosticSnapshot()
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect((body.results as unknown[]).length).toBe(2)
    })

    it('includes lastCheckedAt as takenAt', () => {
      mockGetState.mockReturnValue(makeState([PASSED], false, 9_999_999))
      pushDiagnosticSnapshot()
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>
      expect(body.takenAt).toBe(9_999_999)
    })
  })

  describe('error handling', () => {
    it('swallows fetch errors silently', () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
      mockGetState.mockReturnValue(makeState([PASSED]))
      expect(() => pushDiagnosticSnapshot()).not.toThrow()
    })
  })
})
