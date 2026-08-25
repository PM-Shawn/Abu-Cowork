/**
 * Large-write guard hook.
 *
 * Blocks `write_file` calls that target an already-existing file whose
 * current size exceeds LARGE_WRITE_THRESHOLD_BYTES. Forces the agent
 * onto edit_file for partial modifications instead of full overwrite.
 *
 * Background: when a multi-section document (HTML report, markdown
 * report, long code file) is fully overwritten, sections the user did
 * not ask to change can drift or get silently regenerated with wrong
 * data. edit_file's unique-match contract makes that impossible.
 *
 * Threshold is currently chosen from a single observed case (35 KB
 * HTML report overwrite). Revisit once real-world distribution data
 * is available.
 */
import { exists, stat } from '@tauri-apps/plugin-fs';
import type { PreToolCallEvent } from '../lifecycleHooks';
import { TOOL_NAMES } from '../../tools/toolNames';
import { checkReadPath, isInScopedAuthorizedWorkspace } from '../../tools/pathSafety';
import {
  decideFileUnderRunPermissionCeiling,
  getRunPermissionCeilingFromContext,
} from '../../permissions/runPermissionCeiling';

export const LARGE_WRITE_THRESHOLD_BYTES = 8 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildBlockReason(path: string, size: number): string {
  return `Error: write_file rejected — ${path} already exists (${formatSize(size)}). ` +
    `Full-file overwrite would silently drop sections the user did not ask to change. ` +
    `Use edit_file with old_content + new_content to replace only what needs to change. ` +
    `If a complete rewrite is genuinely intended, delete the file via run_command first, then write_file.`;
}

/**
 * Inspect an already-authorized path for the destructive full-overwrite case.
 *
 * Callers MUST establish read authorization before invoking this helper: it
 * intentionally probes file metadata.  The pre-tool hook does that itself;
 * registry.ts calls it only after its file-permission flow has completed.
 */
export async function getLargeWriteBlockReason(path: string): Promise<string | null> {
  try {
    if (!(await exists(path))) return null;

    const info = await stat(path);
    const size = typeof info?.size === 'number' ? info.size : 0;
    return size >= LARGE_WRITE_THRESHOLD_BYTES
      ? buildBlockReason(path, size)
      : null;
  } catch {
    // The real write path will surface sandbox/IO errors.  This data-integrity
    // guard must not replace those errors with a misleading metadata failure.
    return null;
  }
}

/**
 * Inspect a single preToolCall event and, when it targets write_file
 * over an existing large file, attach blockReason so the executor
 * surfaces an error result to the agent.
 *
 * Legacy evaluator retained for focused tests and compatibility. Production
 * enforcement lives in registry.ts, after file authorization and enterprise
 * policy checks, so this must not be registered on the pre-tool hook bus.
 */
export async function evaluateLargeWriteGuard(event: PreToolCallEvent): Promise<void> {
  if (event.toolName !== TOOL_NAMES.WRITE_FILE) return;
  const path = event.toolInput?.path;
  if (typeof path !== 'string' || !path) return;

  try {
    const context = event.toolContext;
    const ceiling = getRunPermissionCeilingFromContext(context);
    const ceilingDecision = decideFileUnderRunPermissionCeiling(
      ceiling,
      'read',
      isInScopedAuthorizedWorkspace(path, 'read', context?.authorizationScopeId),
    );
    if (ceilingDecision.decision === 'deny') return;

    // This hook runs before registry approval. Never turn exists/stat into a
    // metadata oracle for a path the current run has not already been allowed
    // to read; registry will handle its prompt/denial later in the normal path.
    const readCheck = await checkReadPath(path, context?.authorizationScopeId);
    if (!readCheck.allowed) return;

    const blockReason = await getLargeWriteBlockReason(path);
    if (!blockReason) return;

    event.blocked = true;
    event.blockReason = blockReason;
  } catch {
    // Fail open with respect to the overwrite guard, but do not continue the
    // metadata probe: the real write_file path will surface the underlying
    // authorization/sandbox error.
  }
}

/**
 * Compatibility no-op. The guard used to run on the global preToolCall bus,
 * before registry authorization/policy ordering was known. Keeping the export
 * avoids breaking older imports while ensuring exists/stat can only run from
 * registry.ts after those gates.
 */
export function installLargeWriteGuard(): () => void {
  return () => {};
}
