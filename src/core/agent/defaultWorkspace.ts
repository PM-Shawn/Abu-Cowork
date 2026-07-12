/**
 * Default workspace binding — when an interactive-desktop conversation has no
 * workspace, bind a managed default `~/Abu/<name>/` so the agent has a place to
 * save files instead of improvising (e.g. dumping onto the Desktop).
 *
 * TRAE-style: the workspace is BOUND at loop start (so the system prompt points
 * the agent at it) but the folder is NOT created here — write_file's
 * ensureParentDir materializes it on the first write. A conversation that never
 * writes a file therefore leaves no empty folder on disk.
 *
 * Only interactive-desktop conversations get this — IM / scheduled / trigger
 * runs are headless and must not auto-create workspace directories. That gate
 * lives at the call site (agentLoop).
 */

import { homeDir } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import { authorizeWorkspace } from '@/core/tools/pathSafety';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { getI18n } from '@/i18n';

/** Managed default-workspace root under the user's home directory. */
const ABU_ROOT_DIR = 'Abu';
const MAX_NAME_LEN = 40;

// Control chars + path-hostile characters. Hyphens are kept (valid in folder
// names); spaces are handled by the whitespace collapse in sanitizeWorkspaceName.
// eslint-disable-next-line no-control-regex
const PATH_HOSTILE = new RegExp('[\\u0000-\\u001f/\\\\:*?"<>|]', 'g');

/**
 * Turn a conversation title into a safe single-segment folder name, or null if
 * it yields nothing usable. Strips path-hostile characters, collapses
 * whitespace, trims trailing dots/spaces (Windows-hostile), and caps length.
 */
export function sanitizeWorkspaceName(title: string | undefined | null): string | null {
  if (!title) return null;
  const cleaned = title
    .replace(PATH_HOSTILE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Timestamp folder name `YYYY-MM-DD-HHmmss` (stable, unique, no title needed). */
export function timestampWorkspaceName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Pick the base folder name for a conversation's default workspace: a sanitized
 * title when it's meaningful, else a timestamp (the title is often still the
 * generic "new task" default at loop start).
 */
export function computeDefaultWorkspaceName(title: string | undefined, date: Date): string {
  const genericTitle = getI18n().chatDefaults.newConversationTitle;
  const fromTitle = title && title !== genericTitle ? sanitizeWorkspaceName(title) : null;
  return fromTitle ?? timestampWorkspaceName(date);
}

/**
 * Ensure the conversation has a workspace. No-op (returns the existing path) if
 * it already has one. Otherwise binds a default `~/Abu/<name>/` and returns it.
 * Returns null only if the home directory can't be resolved.
 *
 * Binding mirrors the "add workspace" flow minus the folder picker + mkdir:
 * grant a persistent permission (this is Abu's own managed root), set it as the
 * conversation's workspace, and — when this conversation is the active one —
 * reflect it in the global current path so the UI (workspace card / file tree)
 * updates. The folder itself is created lazily by the first write.
 */
export async function ensureDefaultWorkspace(conversationId: string): Promise<string | null> {
  const chat = useChatStore.getState();
  const conv = chat.conversations[conversationId];
  if (conv?.workspacePath) return conv.workspacePath;

  let home: string;
  try {
    home = await homeDir();
  } catch {
    return null;
  }
  const root = joinPath(normalizeSeparators(home), ABU_ROOT_DIR);
  const base = computeDefaultWorkspaceName(conv?.title, new Date());
  let candidate = joinPath(root, base);

  // Uniqueness: the folder is created lazily, so two conversations could
  // otherwise bind the same path before either writes. Suffix with a short
  // conversation id if another conversation already owns this path, or a folder
  // already exists on disk from an earlier run.
  const takenByOther = Object.values(chat.conversations).some(
    (c) => c.id !== conversationId && c.workspacePath === candidate,
  );
  const onDisk = await exists(candidate).catch(() => false);
  if (takenByOther || onDisk) {
    candidate = joinPath(root, `${base}-${conversationId.slice(0, 6)}`);
  }

  usePermissionStore.getState().grantPermission(candidate, ['read', 'write', 'execute'], 'always');
  chat.setConversationWorkspace(conversationId, candidate);
  if (useChatStore.getState().activeConversationId === conversationId) {
    // setWorkspace also authorizes the path via pathSafety + records it in recents.
    useWorkspaceStore.getState().setWorkspace(candidate);
  } else {
    authorizeWorkspace(candidate);
  }

  return candidate;
}
