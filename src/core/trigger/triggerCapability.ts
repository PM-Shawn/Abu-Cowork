import type { TriggerCapability } from '@/types/trigger';
import { normalizeTriggerRunCapability } from '../permissions/runPermissionCeiling';

/** Treat persisted or forward-version values as the strictest supported tier. */
export function normalizeTriggerCapability(value: unknown): TriggerCapability {
  return normalizeTriggerRunCapability(value);
}
