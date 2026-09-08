/** Regex for valid skill/agent names: lowercase alphanumeric, hyphens allowed (not at start/end) */
export const ITEM_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Agent (队员) names additionally allow CJK and other unicode letters — office
 * users name assistants in Chinese (数据分析师), and builtin agents already do.
 * Matches the composer mention charset (\p{L}\p{N}_-); hyphen/underscore may
 * not lead or trail. Used as directory name + @mention token.
 */
export const AGENT_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u;
