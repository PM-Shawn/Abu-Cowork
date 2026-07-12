/**
 * Default workspace — when an interactive-desktop conversation has no workspace,
 * point the agent at a managed default `~/Abu/<name>/` so it saves files there
 * instead of improvising (e.g. dumping onto the Desktop).
 *
 * LAZY binding: at loop start we only *suggest + authorize* the path (so the
 * system prompt directs the agent and the write isn't blocked). We do NOT bind
 * it to the conversation — a chat-only conversation must not show an empty,
 * non-existent workspace. `write_file` calls `bindWorkspaceFromWrite` on the
 * first successful write under `~/Abu/`, which is when the folder actually
 * exists and the workspace becomes real (file tree / workspace card appear).
 *
 * Only interactive-desktop conversations get this — IM / scheduled / trigger
 * runs are headless. That gate lives at the call sites.
 */

import { homeDir } from '@tauri-apps/api/path';
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

/** `~/Abu`, or null if the home directory can't be resolved. */
async function getAbuRoot(): Promise<string | null> {
  try {
    const home = await homeDir();
    return joinPath(normalizeSeparators(home), ABU_ROOT_DIR);
  } catch {
    return null;
  }
}

/**
 * Suggest (and authorize) a managed default workspace `~/Abu/<name>/` for a
 * conversation that has none, WITHOUT binding it. Returns the path to feed the
 * system prompt so the agent saves there; the write is authorized so it isn't
 * blocked. Binding happens later, in `bindWorkspaceFromWrite`, on the first
 * write. Returns null if the home dir can't be resolved.
 */
export async function prepareSuggestedWorkspace(conversationId: string): Promise<string | null> {
  const conv = useChatStore.getState().conversations[conversationId];
  if (conv?.workspacePath) return conv.workspacePath;

  const root = await getAbuRoot();
  if (!root) return null;
  const suggested = joinPath(root, computeDefaultWorkspaceName(conv?.title, new Date()));

  // Authorize (in-memory, session-scoped) so the eventual write under this path
  // isn't blocked by pathSafety's checkWritePath (it honours authorizedWorkspaces).
  // We deliberately do NOT persist an 'always' permission grant here: this path
  // is only *suggested*, the folder doesn't exist yet, and the suggested name
  // carries a fresh timestamp each turn for a generically-titled conversation —
  // persisting a grant per turn would fill persistedGrants with ghost
  // ~/Abu/<timestamp> entries the user never approved. The durable grant is
  // written once the workspace actually binds, in bindWorkspaceFromWrite.
  authorizeWorkspace(suggested, ['read', 'write']);
  return suggested;
}

/**
 * Called after a successful `write_file`. If the conversation has no workspace
 * and the file was written under `~/Abu/`, bind `~/Abu/<top-level-folder>/` as
 * the conversation's workspace — this is the moment the default workspace
 * becomes real (the folder now exists), so the UI (file tree / workspace card)
 * can show it. No-op if already bound, or the write went elsewhere.
 */
export async function bindWorkspaceFromWrite(
  conversationId: string | undefined,
  writtenPath: string,
): Promise<void> {
  if (!conversationId) return;
  const chat = useChatStore.getState();
  const conv = chat.conversations[conversationId];
  if (!conv || conv.workspacePath) return;
  // Headless runs (scheduled tasks / event triggers) must never auto-create or
  // bind a workspace — matches the interactive-desktop gate on the suggestion
  // side (orchestrator). IM runs never reach here unbound (they either have a
  // preconfigured workspacePath or are told they can't do file ops).
  if (conv.scheduledTaskId || conv.triggerId) return;

  const root = await getAbuRoot();
  if (!root) return;
  const normPath = normalizeSeparators(writtenPath);
  const prefix = `${root}/`;
  if (!normPath.startsWith(prefix)) return; // only auto-bind writes under ~/Abu/

  // Bind the top-level *directory* under ~/Abu. If the model wrote a file
  // directly under ~/Abu (e.g. ~/Abu/report.html — no subfolder), the first
  // segment IS the file, not a directory; binding it would set a non-directory
  // as the workspace and break the file tree (readDir on a file fails). In that
  // case bind ~/Abu itself.
  const segments = normPath.slice(prefix.length).split('/').filter(Boolean);
  if (segments.length === 0) return;
  const workspace = segments.length > 1 ? joinPath(root, segments[0]) : root;

  usePermissionStore.getState().grantPermission(workspace, ['read', 'write', 'execute'], 'always');
  chat.setConversationWorkspace(conversationId, workspace);
  if (useChatStore.getState().activeConversationId === conversationId) {
    // setWorkspace also authorizes the path via pathSafety + records it in recents.
    useWorkspaceStore.getState().setWorkspace(workspace);
  } else {
    authorizeWorkspace(workspace);
  }
}
