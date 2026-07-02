import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { emitTo } from '@tauri-apps/api/event'
import { startPetStatusBridge, stopPetStatusBridge } from './petStatusBridge'
import { publish } from '@/core/notice/bus'
import { useChatStore } from '@/stores/chatStore'
import type { Conversation, ConversationStatus, Message } from '@/types'

const mockEmitTo = emitTo as ReturnType<typeof vi.fn>

const DEDUP_CTR = { n: 0 }
const nextKey = (prefix: string) => `${prefix}-${++DEDUP_CTR.n}`

function makeConv(over: Partial<Conversation> & { id: string; status: ConversationStatus }): Conversation {
  return {
    title: 'Untitled',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function assistantMsg(text: string): Message {
  return { id: `m-${text.slice(0, 4)}`, role: 'assistant', content: text, timestamp: 0 }
}

function setConversations(convs: Conversation[]) {
  const map: Record<string, Conversation> = {}
  for (const c of convs) map[c.id] = c
  useChatStore.setState({ conversations: map })
}

describe('petStatusBridge', () => {
  beforeEach(() => {
    mockEmitTo.mockClear()
    stopPetStatusBridge()
    setConversations([])
  })

  afterEach(() => {
    stopPetStatusBridge()
    setConversations([])
    vi.useRealTimers()
  })

  it('emits idle on start with a full null payload when no conversations are running', () => {
    startPetStatusBridge()
    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', {
      status: 'idle',
      conversationId: null,
      title: null,
      summary: null,
    })
  })

  it('is idempotent — calling start twice does not double-subscribe', () => {
    startPetStatusBridge()
    const callCount = mockEmitTo.mock.calls.length
    startPetStatusBridge()
    expect(mockEmitTo.mock.calls.length).toBe(callCount)
  })

  it('carries the featured conversation title + latest assistant summary', () => {
    setConversations([
      makeConv({
        id: 'c1',
        status: 'running',
        title: '整理桌面文件',
        messages: [
          { id: 'u1', role: 'user', content: '帮我整理', timestamp: 0 },
          assistantMsg('好的，先看一下现有的分类结构，然后按类型归档到对应文件夹里去'),
        ],
      }),
    ])
    startPetStatusBridge()
    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', {
      status: 'running',
      conversationId: 'c1',
      title: '整理桌面文件',
      // 40-char truncation with ellipsis
      summary: '好的，先看一下现有的分类结构，然后按类型归档到对应文件夹里去',
    })
  })

  it('truncates a long assistant summary to 40 chars + ellipsis', () => {
    const long = '一二三四五六七八九十'.repeat(6) // 60 chars
    setConversations([
      makeConv({ id: 'c1', status: 'running', title: 'T', messages: [assistantMsg(long)] }),
    ])
    startPetStatusBridge()
    const call = mockEmitTo.mock.calls.at(-1)!
    const payload = call[2] as { summary: string }
    expect(payload.summary.endsWith('…')).toBe(true)
    expect(payload.summary.length).toBe(41) // 40 + ellipsis
  })

  it('picks the highest-priority conversation as featured', () => {
    setConversations([
      makeConv({ id: 'run', status: 'running', title: 'R', messages: [assistantMsg('running one')] }),
      makeConv({ id: 'err', status: 'error', title: 'E', messages: [assistantMsg('boom')] }),
    ])
    startPetStatusBridge()
    const payload = mockEmitTo.mock.calls.at(-1)![2] as { status: string; conversationId: string }
    expect(payload.status).toBe('error')
    expect(payload.conversationId).toBe('err')
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
    const payload = mockEmitTo.mock.calls.at(-1)![2] as { status: string }
    expect(payload.status).toBe('waiting')
  })

  it('features the notice conversationId in the waiting payload', () => {
    vi.useFakeTimers()
    setConversations([
      makeConv({ id: 'chat', status: 'idle', title: '需要确认', messages: [assistantMsg('可以吗？')] }),
    ])
    startPetStatusBridge()
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    publish({
      type: 'user_input_needed',
      source: 'agent',
      payload: { conversationId: 'chat' },
      dedupKey: nextKey('input'),
    })

    expect(mockEmitTo).toHaveBeenCalledWith('pet', 'pet-status-update', {
      status: 'waiting',
      conversationId: 'chat',
      title: '需要确认',
      summary: '可以吗？',
    })
  })

  it('clears waiting after the notice TTL expires', () => {
    vi.useFakeTimers()
    setConversations([
      makeConv({ id: 'c1', status: 'running', title: 'R', messages: [assistantMsg('在跑')] }),
    ])
    startPetStatusBridge()
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    publish({
      type: 'user_input_needed',
      source: 'agent',
      payload: { conversationId: 'c1' },
      dedupKey: nextKey('ttl'),
      ttl: 5_000,
    })
    expect((mockEmitTo.mock.calls.at(-1)![2] as { status: string }).status).toBe('waiting')

    // Advance past the TTL — the notice auto-resolves and waiting clears.
    vi.advanceTimersByTime(5_000)
    expect((mockEmitTo.mock.calls.at(-1)![2] as { status: string }).status).toBe('running')
  })

  it('keeps the still-active notice featured when a newer shorter-TTL notice expires', () => {
    // Regression guard for the overlapping-notice stale-pointer bug: a later
    // notice with a shorter TTL must NOT leave its (expired) conversation
    // featured while an earlier, longer-lived notice is still waiting.
    vi.useFakeTimers()
    setConversations([
      makeConv({ id: 'conv1', status: 'idle', title: '会话一', messages: [assistantMsg('一的回复')] }),
      makeConv({ id: 'conv2', status: 'idle', title: '会话二', messages: [assistantMsg('二的回复')] }),
    ])
    startPetStatusBridge()
    vi.advanceTimersByTime(4_000)
    mockEmitTo.mockClear()

    // Notice A → conv1, long TTL
    publish({
      type: 'user_input_needed',
      source: 'agent',
      payload: { conversationId: 'conv1' },
      dedupKey: nextKey('A'),
      ttl: 30_000,
    })
    // Notice B → conv2, arrives later with a short TTL
    vi.advanceTimersByTime(4_000)
    publish({
      type: 'user_input_needed',
      source: 'agent',
      payload: { conversationId: 'conv2' },
      dedupKey: nextKey('B'),
      ttl: 5_000,
    })
    expect(mockEmitTo.mock.calls.at(-1)![2]).toMatchObject({ status: 'waiting', conversationId: 'conv2' })

    // B expires — A (conv1) is still waiting, so the payload must fall back
    // to conv1, not the stale conv2.
    vi.advanceTimersByTime(5_000)
    const last = mockEmitTo.mock.calls.at(-1)![2] as { status: string; conversationId: string }
    expect(last.status).toBe('waiting')
    expect(last.conversationId).toBe('conv1')
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
