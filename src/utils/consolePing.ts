import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getPlatform } from './platform'
import { getTelemetryTarget } from './consoleTelemetryTarget'

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
