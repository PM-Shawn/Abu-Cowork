/**
 * Project Types — organizational container for conversations
 *
 * A Project binds to a single workspace folder (1:1) and provides:
 * - Default configuration inherited by new conversations
 * - Grouping of related conversations in the sidebar
 * - Association point for scheduled tasks, triggers, and IM channels
 *
 * Memory and rules are NOT stored per-project — they live in the
 * workspace folder ({workspacePath}/.abu/) and are unchanged.
 */

export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Emoji icon for sidebar display */
  icon?: string;
  /** Bound workspace folder path (unique constraint: one folder = one project) */
  workspacePath: string;

  // --- Default configuration (inherited by new conversations) ---

  /** Default active skills for new conversations */
  defaultSkills?: string[];
  /** Default per-skill arguments */
  defaultSkillArgs?: Record<string, string>;
  /** Default enabled MCP servers */
  defaultMCPServers?: string[];
  /** Project-level model override (null = follow global setting) */
  modelOverride?: string;

  // --- Organization ---

  /** Pinned to top of sidebar */
  pinned: boolean;
  /** Archived (hidden from main list, restorable) */
  archived: boolean;

  // --- Timestamps ---

  createdAt: number;
  updatedAt: number;
  /** Last time any conversation in this project was active */
  lastActiveAt: number;
}
