import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'

const LAST_PING_KEY = 'abu_last_ping_date'

/** UTC 日历日期（YYYY-MM-DD），与服务端 ping_date 分桶一致。 */
export function pingDateUTC(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** 纯判断：该设备是否还没在 now 的 UTC 日打过 ping。 */
export function shouldPingToday(now: Date, lastPingDate: string | null): boolean {
  return lastPingDate !== pingDateUTC(now)
}

export function sendConsolePing(): void {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return

  const payload = {
    deviceId: getDeviceId(),
    appVersion: APP_VERSION,
    platform: getPlatform() ?? 'unknown',
    osVersion: navigator.userAgent,
  }

  fetch(`${baseUrl}/api/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // fire-and-forget，失败静默
  })
}

/**
 * 每个 UTC 日历日至多发送一次 ping，把当天记进 localStorage，同日后续触发变 no-op。
 * 服务端幂等，偶发重发无害。返回是否真的发送了。
 */
export function maybeSendConsolePing(now: Date = new Date()): boolean {
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_PING_KEY)
  } catch {
    // localStorage 不可用时按「未打过」处理
  }
  if (!shouldPingToday(now, last)) return false
  try {
    localStorage.setItem(LAST_PING_KEY, pingDateUTC(now))
  } catch {
    // 忽略写入失败
  }
  sendConsolePing()
  return true
}
