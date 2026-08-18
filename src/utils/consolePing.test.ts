import { describe, it, expect } from 'vitest'
import { pingDateUTC, shouldPingToday } from './consolePing'

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
