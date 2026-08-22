// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const maybeSend = vi.fn()
vi.mock('@/utils/consolePing', () => ({
  maybeSendConsolePing: () => maybeSend(),
}))

import { usePingCadence } from './usePingCadence'

describe('usePingCadence', () => {
  beforeEach(() => {
    maybeSend.mockClear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂载时打一次', () => {
    renderHook(() => usePingCadence())
    expect(maybeSend).toHaveBeenCalledTimes(1)
  })

  it('到达定时器间隔再打一次', () => {
    renderHook(() => usePingCadence())
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(maybeSend).toHaveBeenCalledTimes(2)
  })

  it('窗口重新可见时补打', () => {
    renderHook(() => usePingCadence())
    maybeSend.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(maybeSend).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再触发', () => {
    const { unmount } = renderHook(() => usePingCadence())
    maybeSend.mockClear()
    unmount()
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(maybeSend).not.toHaveBeenCalled()
  })
})
