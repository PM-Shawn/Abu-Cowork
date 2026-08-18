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
 * 尽力保证每个 UTC 日历日至多发送一次 ping（best-effort 遥测）。
 * 仅在遥测启用时才登记与发送；关闭时既不登记也不发送、返回 false
 * （否则关闭期间记了日期，当天再开启会漏打——企业版 config 延迟加载时尤甚）。
 * 注意：日期在发送前登记且失败不重试——网络抖动可能漏掉当天，次日自愈（宁可少报也不轰炸服务端）。
 * 返回 true 表示本次触发确实发起了一次发送。
 */
export function maybeSendConsolePing(now: Date = new Date()): boolean {
  if (!getTelemetryTarget().enabled) return false
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
