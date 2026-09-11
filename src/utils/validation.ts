/** Regex for valid skill/agent names: lowercase alphanumeric, hyphens allowed (not at start/end) */
export const ITEM_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Agent (队员) names additionally allow CJK and other unicode letters — office
 * users name assistants in Chinese (数据分析师), and builtin agents already do.
 * Matches the composer mention charset (\p{L}\p{N}_-); hyphen/underscore may
 * not lead or trail. Used as directory name + @mention token.
 */
export const AGENT_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u;

/**
 * Does `candidate` collide with a name some OTHER item already uses?
 *
 * Case-insensitive: an item lives in `~/.abu/<folder>/<name>/`, and the macOS
 * and Windows file systems treat `Reviewer` and `reviewer` as the same folder —
 * saving one would overwrite the other. The item being edited (`existingName`)
 * never collides with itself, so renaming `reviewer` → `Reviewer` stays allowed.
 *
 * Shared by the editors (`useItemName`) and the model's `save_agent` tool and
 * `skill_manage` create, so every path that writes an item's folder refuses
 * the same names.
 */
export function isItemNameTaken(
  candidate: string,
  existingName: string | null,
  takenNames: Iterable<string>,
): boolean {
  const wanted = candidate.trim().toLowerCase();
  if (!wanted) return false;
  for (const taken of takenNames) {
    if (taken === existingName) continue;
    if (taken.toLowerCase() === wanted) return true;
  }
  return false;
}
