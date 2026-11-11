import { getSettingsReader } from '../agent/ports/settingsReader';
import type { PermissionMode } from './permissionMode';

/**
 * The permission mode a run is actually judged under: the first mode that is
 * set, in the order given (a conversation's own, a scheduled task's, the one
 * the tool context carries), else the global setting. An unset layer means
 * "follow the layer below", never "strictest".
 */
export function effectivePermissionMode(...layers: ReadonlyArray<PermissionMode | undefined | null>): PermissionMode {
  for (const mode of layers) if (mode) return mode;
  return getSettingsReader().getSnapshot().permissionMode;
}
