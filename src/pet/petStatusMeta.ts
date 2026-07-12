import type { PetStatus } from '@/core/pet/petStatusBridge'

/**
 * Shared status → color map for the pet window. Used by the context menu
 * and the Activity Notification Tray bubble so the status dot color stays
 * consistent across both surfaces. Status *labels* are resolved through
 * i18n (`t.pet.status[status]`) at render time, not stored here.
 */

export const STATUS_COLOR: Record<PetStatus, string> = {
  idle: '#6b7280',
  running: '#3b82f6',
  waiting: '#f97316',
  error: '#ef4444',
  done: '#22c55e',
}
