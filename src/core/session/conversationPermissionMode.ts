/**
 * The permission mode a conversation keeps for itself. It lives on the
 * loaded `Conversation` and on the conversation's row of `index.json`
 * (`ConversationMeta.permissionMode`); absent means the conversation follows
 * the global default.
 *
 * Pure: no store, no I/O, never throws.
 */
import { isPermissionMode, type PermissionMode } from '../permissions/permissionMode';

/**
 * The one rule for which permission mode a conversation may hold. The
 * store's setter, the new-conversation path, the index reader and writer,
 * the restore and the import path all ask this function, so a value read
 * from disk is never accepted where a live pick would be refused.
 */
export function acceptConversationPermissionMode(value: unknown): PermissionMode | undefined {
  return isPermissionMode(value) ? value : undefined;
}

/**
 * An index entry as a tolerant reader sees it: a `permissionMode` the rule
 * above refuses is left out, every other field stays. An entry without the
 * key, or with an accepted mode, is returned as it is.
 */
export function withAcceptedPermissionMode<T extends object>(entry: T): T {
  if (!('permissionMode' in entry)) return entry;
  const { permissionMode, ...rest } = entry as T & { permissionMode?: unknown };
  return acceptConversationPermissionMode(permissionMode) === undefined ? (rest as T) : entry;
}
