// src/core/enterprise/useDeepLinkEnroll.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDeepLinkEnroll } from './useDeepLinkEnroll'

// Mock the deep-link plugin — not in global setup.ts because it's only needed here.
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}))

import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'

const mockGetCurrent = getCurrent as ReturnType<typeof vi.fn>
const mockOnOpenUrl = onOpenUrl as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no launch URL, onOpenUrl registers but never fires
  mockGetCurrent.mockResolvedValue(null)
  mockOnOpenUrl.mockResolvedValue(vi.fn())
})

describe('useDeepLinkEnroll', () => {
  describe('cold-launch URL via getCurrent', () => {
    it('sets pendingEnroll when app is cold-launched with abu://enroll', async () => {
      mockGetCurrent.mockResolvedValue(['abu://enroll?server=https://corp.example.com&token=tok123'])

      const { result } = renderHook(() => useDeepLinkEnroll())

      await waitFor(() => {
        expect(result.current.pendingEnroll).toEqual({
          serverUrl: 'https://corp.example.com',
          enrollmentToken: 'tok123',
        })
      })
    })

    it('sets pendingEnroll without token when token param is absent', async () => {
      mockGetCurrent.mockResolvedValue(['abu://enroll?server=https://corp.example.com'])

      const { result } = renderHook(() => useDeepLinkEnroll())

      await waitFor(() => {
        expect(result.current.pendingEnroll).toEqual({
          serverUrl: 'https://corp.example.com',
        })
      })
    })

    it('does not set pendingEnroll for unrecognized scheme', async () => {
      mockGetCurrent.mockResolvedValue(['https://irrelevant.example.com/path'])

      const { result } = renderHook(() => useDeepLinkEnroll())

      await act(async () => { await Promise.resolve() })

      expect(result.current.pendingEnroll).toBeNull()
    })

    it('does not set pendingEnroll when getCurrent returns null', async () => {
      mockGetCurrent.mockResolvedValue(null)

      const { result } = renderHook(() => useDeepLinkEnroll())

      await act(async () => { await Promise.resolve() })

      expect(result.current.pendingEnroll).toBeNull()
    })

    it('does not throw when getCurrent rejects (non-Tauri environment)', async () => {
      mockGetCurrent.mockRejectedValue(new Error('not available'))

      const { result } = renderHook(() => useDeepLinkEnroll())

      await act(async () => { await Promise.resolve() })

      expect(result.current.pendingEnroll).toBeNull()
    })
  })

  describe('live URL via onOpenUrl', () => {
    it('sets pendingEnroll when onOpenUrl fires with an enroll URL', async () => {
      let capturedHandler: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((handler: (urls: string[]) => void) => {
        capturedHandler = handler
        return Promise.resolve(vi.fn())
      })

      const { result } = renderHook(() => useDeepLinkEnroll())

      // wait for onOpenUrl promise to resolve
      await act(async () => { await Promise.resolve() })

      expect(capturedHandler).toBeDefined()

      await act(async () => {
        capturedHandler!(['abu://enroll?server=https://live.example.com&token=livetoken'])
      })

      expect(result.current.pendingEnroll).toEqual({
        serverUrl: 'https://live.example.com',
        enrollmentToken: 'livetoken',
      })
    })
  })

  describe('dismissEnroll', () => {
    it('clears pendingEnroll when dismissEnroll is called', async () => {
      mockGetCurrent.mockResolvedValue(['abu://enroll?server=https://corp.example.com'])

      const { result } = renderHook(() => useDeepLinkEnroll())

      await waitFor(() => {
        expect(result.current.pendingEnroll).not.toBeNull()
      })

      act(() => result.current.dismissEnroll())

      expect(result.current.pendingEnroll).toBeNull()
    })
  })

  describe('cleanup on unmount', () => {
    it('calls unlisten on unmount to avoid memory leaks', async () => {
      const mockUnlisten = vi.fn()
      mockOnOpenUrl.mockResolvedValue(mockUnlisten)

      const { unmount } = renderHook(() => useDeepLinkEnroll())

      await act(async () => { await Promise.resolve() })

      unmount()

      expect(mockUnlisten).toHaveBeenCalledOnce()
    })
  })
})
