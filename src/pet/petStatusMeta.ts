import type { PetStatus } from '@/core/pet/petStatusBridge'

/**
 * Shared status → color for the pet window. Used by the context menu and the
 * Activity Notification Tray bubble so the status dot stays consistent across
 * both surfaces. Status *labels* are resolved through i18n
 * (`t.pet.status[status]`) at render time, not stored here.
 *
 * Each value is the text color class of a design token; the dot is filled with
 * it (`bg-current`), so it has the contrast that token is checked for on the
 * raised surface in both appearances. Complete literals so Tailwind generates
 * them.
 */
export const STATUS_TONE: Record<PetStatus, string> = {
  idle: 'text-label-tertiary',
  running: 'text-info',
  waiting: 'text-warning',
  error: 'text-danger',
  done: 'text-success',
}
