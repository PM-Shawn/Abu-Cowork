import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { emitTo } from '@tauri-apps/api/event'
import { startPetStatusBridge, stopPetStatusBridge } from './petStatusBridge'
import { publish } from '@/core/notice/bus'

const mockEmitTo = emitTo as ReturnType<typeof vi.fn>

const DEDUP_CTR = { n: 0 }
const nextKey = (prefix: string) => `${prefix}-${++DEDUP_CTR.n}`

describe('petStatusBridge', () => {
  beforeEach(() => {
    mockEmitTo.mockClear()
    stopPetStatusBridge()
  })

  afterEach(() => {
    stopPetStatusBridge()
    vi.useRealTimers()
  })

  it('emits idle on start when no conversations are running', () => {
    startPetStatusBridge()
    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', { status: 'idle' })
  })

  it('is idempotent — calling start twice does not double-subscribe', () => {
    startPetStatusBridge()
    const callCount = mockEmitTo.mock.calls.length
    startPetStatusBridge()
    expect(mockEmitTo.mock.calls.length).toBe(callCount)
  })

  it('emits waiting when a permission_request notice is published', () => {
    vi.useFakeTimers()
    startPetStatusBridge()
    // Advance past the 3 s debounce window so the next scheduleEmit fires immediately
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    publish({
      type: 'permission_request',
      source: 'agent',
      payload: {},
      dedupKey: nextKey('perm'),
    })

    // elapsed >= MIN_INTERVAL_MS → emitNow called synchronously
    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', { status: 'waiting' })
  })

  it('emits waiting when a user_input_needed notice is published', () => {
    vi.useFakeTimers()
    startPetStatusBridge()
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    publish({
      type: 'user_input_needed',
      source: 'agent',
      payload: {},
      dedupKey: nextKey('input'),
    })

    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', { status: 'waiting' })
  })

  it('does not emit waiting for unrelated notice types', () => {
    vi.useFakeTimers()
    startPetStatusBridge()
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    publish({
      type: 'update_available',
      source: 'core',
      payload: {},
      dedupKey: nextKey('update'),
    })

    // update_available should not trigger waiting
    const waitingCalls = mockEmitTo.mock.calls.filter(
      ([, , payload]) => (payload as { status: string }).status === 'waiting'
    )
    expect(waitingCalls.length).toBe(0)
  })

  it('cleans up subscriptions on stop', () => {
    startPetStatusBridge()
    stopPetStatusBridge()
    mockEmitTo.mockClear()

    // Bridge is stopped — no handler should fire
    publish({
      type: 'permission_request',
      source: 'agent',
      payload: {},
      dedupKey: nextKey('stop'),
    })

    expect(mockEmitTo).not.toHaveBeenCalled()
  })
})
