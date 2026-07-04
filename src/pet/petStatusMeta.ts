import type { PetStatus } from '@/core/pet/petStatusBridge'

/**
 * Shared status → color / label maps for the pet window. Used by the
 * context menu and the Activity Notification Tray bubble so the status
 * dot color stays consistent across both surfaces.
 */

export const STATUS_COLOR: Record<PetStatus, string> = {
  idle: '#6b7280',
  running: '#3b82f6',
  waiting: '#f97316',
  error: '#ef4444',
  done: '#22c55e',
}

export const STATUS_LABEL: Record<PetStatus, string> = {
  idle: '空闲',
  running: '处理中…',
  waiting: '等待输入',
  error: '遇到问题',
  done: '完成',
}
