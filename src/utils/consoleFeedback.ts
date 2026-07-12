import { getDeviceId } from './deviceId'
import { APP_VERSION } from './version'
import { getTelemetryTarget } from './consoleTelemetryTarget'

export function sendFeedback(
  rating: 'positive' | 'negative' | 'cancel',
  conversationId?: string,
  messageId?: string,
  skillName?: string | null,
): void {
  const { baseUrl, enabled } = getTelemetryTarget()
  if (!enabled) return

  fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      conversationId,
      messageId,
      rating,
      skillName: skillName ?? null,
      appVersion: APP_VERSION,
    }),
  }).catch(() => {})
}
