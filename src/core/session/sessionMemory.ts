/**
 * Session Memory — persists large tool results to disk.
 *
 * Problem: localStorage has a ~5MB quota. Tool results (grep, read_file, etc.)
 * can easily exceed this when accumulated across many tool calls.
 *
 * Solution: Tool results exceeding a size threshold are written to disk in the
 * session directory. The chatStore keeps a compact reference with a truncated
 * preview. The full content can be loaded on demand.
 *
 * Layout:
 *   ~/Library/Application Support/com.abu.app/conversations/{convId}/results/{toolCallId}.txt
 */

import { exists, mkdir, readTextFile, writeTextFile, remove } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { createConversationPaths, type ConversationPaths } from './conversationPaths';

/** Tool results larger than this are offloaded to disk (bytes, ~8KB) */
const OFFLOAD_THRESHOLD = 8192;

/** Preview length kept in memory (chars) */
const PREVIEW_LENGTH = 500;

/** Marker prefix indicating the result is stored on disk */
export const DISK_REF_PREFIX = '[session-memory:';
export const DISK_REF_SUFFIX = ']';

let cachedPaths: ConversationPaths | null = null;

async function conversationPaths(): Promise<ConversationPaths> {
  if (!cachedPaths) {
    cachedPaths = createConversationPaths(await appDataDir());
  }
  return cachedPaths;
}

/**
 * Get the results directory for a specific conversation.
 */
async function getResultsDir(conversationId: string): Promise<string> {
  return (await conversationPaths()).resultsDir(conversationId);
}

/**
 * Check if a tool result should be offloaded to disk.
 */
export function shouldOffload(result: string): boolean {
  return result.length > OFFLOAD_THRESHOLD;
}

/**
 * Check if a result string is a disk reference.
 */
export function isDiskRef(result: string): boolean {
  return result.startsWith(DISK_REF_PREFIX) && result.includes(DISK_REF_SUFFIX);
}

/**
 * Extract the tool call ID from a disk reference string.
 */
export function extractRefId(result: string): string | null {
  if (!isDiskRef(result)) return null;
  const start = DISK_REF_PREFIX.length;
  const end = result.indexOf(DISK_REF_SUFFIX, start);
  if (end === -1) return null;
  return result.substring(start, end);
}

/**
 * Create a disk reference string with a preview of the content.
 * Includes the full output size so the LLM knows how much was omitted.
 */
export function createDiskRef(toolCallId: string, fullResult: string): string {
  const preview = fullResult.slice(0, PREVIEW_LENGTH);
  const truncated = fullResult.length > PREVIEW_LENGTH ? '...' : '';
  return `${DISK_REF_PREFIX}${toolCallId}${DISK_REF_SUFFIX}\n[Full output: ${fullResult.length} chars, showing first ${Math.min(PREVIEW_LENGTH, fullResult.length)} chars]\n${preview}${truncated}`;
}

/**
 * Offload a large tool result to disk.
 * Returns a compact reference string to store in memory.
 */
export async function offloadResult(
  conversationId: string,
  toolCallId: string,
  result: string,
): Promise<string> {
  const dir = await getResultsDir(conversationId);
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }

  const filePath = joinPath(dir, `${toolCallId}.txt`);
  await writeTextFile(filePath, result);

  return createDiskRef(toolCallId, result);
}

/**
 * Load a full tool result from disk.
 * Returns the full content, or null if the file doesn't exist.
 */
export async function loadResult(
  conversationId: string,
  toolCallId: string,
): Promise<string | null> {
  const dir = await getResultsDir(conversationId);
  const filePath = joinPath(dir, `${toolCallId}.txt`);

  try {
    if (await exists(filePath)) {
      return await readTextFile(filePath);
    }
    // Fallback: check old `sessions/` path for backward compatibility with pre-migration data
    const paths = await conversationPaths();
    const legacyPath = joinPath(paths.legacySessionDir(conversationId), 'results', `${toolCallId}.txt`);
    if (await exists(legacyPath)) {
      return await readTextFile(legacyPath);
    }
  } catch {
    // File read failed — return null
  }
  return null;
}

/**
 * Clean up all session results for a conversation.
 */
export async function cleanupConversationResults(conversationId: string): Promise<void> {
  const dir = await getResultsDir(conversationId);
  try {
    if (await exists(dir)) {
      await remove(dir, { recursive: true });
    }
  } catch {
    // Cleanup failure is non-critical
  }
}

/**
 * Process a tool result: offload to disk if large, otherwise return as-is.
 * This is the main entry point called from the tool executor.
 */
export async function processToolResult(
  conversationId: string,
  toolCallId: string,
  result: string,
): Promise<{ stored: string; offloaded: boolean }> {
  if (shouldOffload(result)) {
    const ref = await offloadResult(conversationId, toolCallId, result);
    return { stored: ref, offloaded: true };
  }
  return { stored: result, offloaded: false };
}
