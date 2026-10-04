/**
 * The renderer's file access for the conversation writer.
 *
 * Every call crosses into the Electron main process, which applies its own
 * capability scope to the path. `appendText` tries the native O(1) append
 * first; when that command is unavailable or rejects, it reads the file and
 * rewrites it atomically with the new data at the end. That second path is
 * not idempotent: if the native append wrote `data` and its promise still
 * rejected (IPC teardown), the same line is written twice, which the ledger
 * projection folds into one message. An oversize body is never retried,
 * because the rewrite's body is larger still (#549 M2).
 */
import { exists, mkdir, readDir, readTextFile, remove, stat } from '@tauri-apps/plugin-fs';
import { atomicWrite } from '@/utils/atomicFs';
import { invokeTextCommand } from '@/core/ipc/rawBodyInvoke';
import { isPayloadTooLargeError } from '@/core/ipc/payloadTooLarge';
import { canonicalizeElectronPathForPolicy } from '@/utils/electronHost';
import type { ConversationFsPrimitives } from './conversationWriter';

async function appendText(filePath: string, data: string): Promise<void> {
  try {
    // Native O(1) append (Part B1) — raw-body in Electron (#549). Falls back
    // to read+atomic-rewrite below if the command is unavailable or fails.
    await invokeTextCommand('append_file_text', { path: filePath }, data);
    return;
  } catch (err) {
    // An oversize line can never be written by rewriting the whole file
    // (that body is even larger) — surface it instead (#549 M2).
    if (isPayloadTooLargeError(err)) throw err;
    // Fall through to the read + atomic-write path. NOTE: this fallback is not
    // idempotent — if the native append durably wrote `data` but its promise
    // still rejected (IPC teardown / shutdown race), we re-append the same
    // line here, producing a DUPLICATE (not a corrupt line). loadMessages
    // dedups by id on read, so the duplicate never surfaces.
  }
  try {
    if (await exists(filePath)) {
      const current = await readTextFile(filePath);
      await atomicWrite(filePath, current + data);
    } else {
      // atomicWrite creates parent dirs as needed — no pre-mkdir required.
      await atomicWrite(filePath, data);
    }
  } catch (rewriteErr) {
    // The retry below writes `existing + data`, which is never SMALLER than
    // the body that was just refused — an oversize rewrite can only fail
    // again, more expensively. Surface it instead (#549 M2), mirroring the
    // native-append rethrow above.
    if (isPayloadTooLargeError(rewriteErr)) throw rewriteErr;
    // Retry: ensure directory exists, then re-read existing content to preserve it.
    // Previous implementation wrote only `data` here, which would overwrite the
    // entire file and destroy all existing messages — a catastrophic data loss bug.
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir) await mkdir(dir, { recursive: true });
    let existing = '';
    try {
      if (await exists(filePath)) {
        existing = await readTextFile(filePath);
      }
    } catch {
      // If we still can't read, at least don't destroy what's there — let it throw
    }
    await atomicWrite(filePath, existing + data);
  }
}

export const rendererConversationFs: ConversationFsPrimitives = {
  exists: (path) => exists(path),
  readTextFile: (path) => readTextFile(path),
  mkdir: (path, options) => mkdir(path, options),
  remove: (path, options) => (options ? remove(path, options) : remove(path)),
  readDir: async (path) => (await readDir(path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory })),
  stat: async (path) => ({ size: (await stat(path)).size }),
  appendText,
  atomicWriteText: (path, content) => atomicWrite(path, content),
  // The directory entry itself: a conversation directory that is a link is judged by where it points.
  canonicalPath: (path) => canonicalizeElectronPathForPolicy(path, true),
};
