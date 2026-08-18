import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pingDateUTC, shouldPingToday, maybeSendConsolePing } from './consolePing'

// telemetry 目标可切换启用状态，避免依赖 enterprise store
const mockTelemetry = vi.hoisted(() => ({ enabled: true }))
vi.mock('./consoleTelemetryTarget', () => ({
  getTelemetryTarget: () => ({ baseUrl: 'https://console.example', enabled: mockTelemetry.enabled }),
}))

describe('pingDateUTC', () => {
  it('返回 UTC 日历日期，与服务端 ping_date 对齐', () => {
    expect(pingDateUTC(new Date('2026-08-11T23:30:00Z'))).toBe('2026-08-11')
    expect(pingDateUTC(new Date('2026-08-12T00:10:00Z'))).toBe('2026-08-12')
  })
})

describe('shouldPingToday', () => {
  const now = new Date('2026-08-11T10:00:00Z')
  it('从未打过 → 应打', () => {
    expect(shouldPingToday(now, null)).toBe(true)
  })
  it('今天已打过 → 不打', () => {
    expect(shouldPingToday(now, '2026-08-11')).toBe(false)
  })
  it('上次是昨天 → 应打', () => {
    expect(shouldPingToday(now, '2026-08-10')).toBe(true)
  })
})

describe('maybeSendConsolePing', () => {
  beforeEach(() => {
    mockTelemetry.enabled = true
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('遥测关闭时不发送也不记录日期', () => {
    mockTelemetry.enabled = false
    expect(maybeSendConsolePing(new Date('2026-08-11T10:00:00Z'))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(localStorage.getItem('abu_last_ping_date')).toBeNull()
  })

  it('首次调用发送一次并记录当天', () => {
    expect(maybeSendConsolePing(new Date('2026-08-11T10:00:00Z'))).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('abu_last_ping_date')).toBe('2026-08-11')
  })

  it('同一天第二次不发送', () => {
    maybeSendConsolePing(new Date('2026-08-11T10:00:00Z'))
    expect(maybeSendConsolePing(new Date('2026-08-11T20:00:00Z'))).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('跨到次日再次发送', () => {
    maybeSendConsolePing(new Date('2026-08-11T10:00:00Z'))
    expect(maybeSendConsolePing(new Date('2026-08-12T00:05:00Z'))).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('abu_last_ping_date')).toBe('2026-08-12')
  })
})
