/**
 * Pre-edit snapshots for AI file tools (write_file / edit_file).
 *
 * Bridges the AI edit path into the same per-file version history the preview
 * panel's manual editor uses (`canvasVersions`), so every AI turn that touches
 * a file leaves a revertable "before" state. Follows the competitor consensus
 * (Claude Code / WorkBuddy / TRAE — see
 * docs/2026-07-19-ai-edit-version-history-design.md): snapshot on FIRST touch
 * per turn, full content, fail-open (a snapshot failure must never block the
 * edit itself).
 */

import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { snapshotVersion } from '@/utils/canvasVersions';
import { normalizeSeparators } from '@/utils/pathUtils';
import { getMessageText } from '@/core/context/contextUtils';
import { useChatStore } from '@/stores/chatStore';

/** Files larger than this are not snapshotted — guards disk usage. Preview-
 *  editable files are far smaller; competitors have no cap at all. */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
/** Max label length persisted into the version index. */
const MAX_LABEL_CHARS = 60;
/** Bounded number of loops tracked for first-touch dedup (FIFO beyond this). */
const MAX_TRACKED_LOOPS = 8;

// loopId -> normalized paths already snapshotted this turn. Eviction is FIFO
// by loop-creation order (re-touching does not refresh position) — an evicted
// loop's next touch just re-snapshots, which the store's dedupe absorbs.
const touchedByLoop = new Map<string, Set<string>>();

/** Returns true when this is the first touch of `path` within `loopId`. */
function markTouched(loopId: string, path: string): boolean {
  let set = touchedByLoop.get(loopId);
  if (!set) {
    set = new Set();
    touchedByLoop.set(loopId, set);
    while (touchedByLoop.size > MAX_TRACKED_LOOPS) {
      const oldest = touchedByLoop.keys().next().value;
      if (oldest === undefined) break;
      touchedByLoop.delete(oldest);
    }
  }
  if (set.has(path)) return false;
  set.add(path);
  return true;
}

/** Best-effort label: latest non-system user message of the conversation. */
function latestUserMessageLabel(conversationId?: string): string | undefined {
  if (!conversationId) return undefined;
  try {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv) return undefined;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === 'user' && !m.isSystem) {
        const text = getMessageText(m.content).trim();
        if (!text) return undefined;
        return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS)}…` : text;
      }
    }
  } catch {
    // Label is decoration only — never let it interfere with the snapshot.
  }
  return undefined;
}

/**
 * Snapshot the current on-disk content of `path` before an AI tool overwrites
 * it. First-touch-per-loop semantics; new files (nothing on disk yet) and
 * oversize files are skipped. NEVER throws.
 */
export async function snapshotBeforeAiEdit(
  path: string,
  opts: { loopId?: string; conversationId?: string; knownContent?: string }
): Promise<void> {
  try {
    const key = normalizeSeparators(path).replace(/\/+$/, '');
    // Missing loopId (not expected in practice) degrades to attempting every
    // time — the store's content dedupe keeps history from growing.
    if (opts.loopId && !markTouched(opts.loopId, key)) return;
    if (!(await exists(path))) return; // new file — no "before" to capture

    let content = opts.knownContent;
    if (content === undefined) {
      const info = await stat(path);
      if (info.size > MAX_SNAPSHOT_BYTES) {
        console.warn('[aiEditSnapshots] skip oversize file', path, info.size);
        return;
      }
      content = await readTextFile(path);
    } else if (new TextEncoder().encode(content).length > MAX_SNAPSHOT_BYTES) {
      console.warn('[aiEditSnapshots] skip oversize content', path);
      return;
    }

    await snapshotVersion(path, content, {
      source: 'ai',
      label: latestUserMessageLabel(opts.conversationId),
    });
  } catch (err) {
    console.warn('[aiEditSnapshots] snapshot failed (non-blocking)', path, err);
  }
}

/** @internal — exposed for unit tests only */
export const __testing = { markTouched, MAX_SNAPSHOT_BYTES, MAX_TRACKED_LOOPS };
