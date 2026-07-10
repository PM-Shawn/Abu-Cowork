import type { Message, MessageContent } from '../../types';
import { resolveFileSource } from '../session/outputSnapshots';
import { uint8ArrayToBase64 } from '../../utils/base64';
import { getBaseName } from '../../utils/pathUtils';
import { createLogger } from '../logging/logger';

const logger = createLogger('imageRehydration');

/** Cache of filePath → base64 (or null when unrecoverable) for the lifetime of
 *  a single user request. A tool-use loop re-sends the whole history every turn;
 *  the store's `source.data` stays stripped, so without this every iteration
 *  would re-read + re-encode every image from disk. */
export type ImageBase64Cache = Map<string, string | null>;

/**
 * Re-read a stripped image's base64 from its disk copy (live file or snapshot).
 * Returns null when the file is unrecoverable (expired / missing / read error) —
 * callers must degrade gracefully, never emit an empty base64.
 */
async function readImageAsBase64(
  conversationId: string | undefined,
  filePath: string,
  workspacePath: string | null,
  cache?: ImageBase64Cache,
): Promise<string | null> {
  if (cache?.has(filePath)) return cache.get(filePath) ?? null;
  let result: string | null = null;
  try {
    const resolved = await resolveFileSource(conversationId, filePath, workspacePath);
    if (resolved.status === 'available') {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const bytes = await readFile(resolved.path);
      result = uint8ArrayToBase64(bytes);
    }
  } catch (e) {
    logger.warn('image rehydrate failed', { filePath, err: String(e) });
    result = null;
  }
  cache?.set(filePath, result);
  return result;
}

/**
 * Rehydrate stripped image base64 before a conversation is sent to the LLM.
 *
 * Images are persisted with `source.data` cleared to save disk — only `filePath`
 * survives (see `stripForDisk` in conversationStorage.ts). The UI thumbnail
 * reloads from disk, but the LLM send path used the empty `source.data`
 * directly, emitting `data:<mime>;base64,` (empty) → upstream rejects with
 * "Invalid base64 image_url", which bricks EVERY subsequent turn (text included,
 * since the whole history is re-sent each turn). See
 * project-image-empty-base64-after-reload-bug.
 *
 * This mirrors WorkBuddy's `rehydrateItem`: for each image block whose base64
 * was stripped, re-read it from `filePath` (or its snapshot); if unrecoverable,
 * replace the block with a text placeholder so we NEVER send empty base64.
 *
 * Only call this for vision-capable models — non-vision models strip images in
 * `normalizeMessages` anyway, so rehydrating would just waste disk reads.
 *
 * Pure / immutable: returns new message + content objects and never mutates the
 * input, so the store's displayed image and the next disk flush stay untouched.
 */
export async function rehydrateImageData(
  messages: Message[],
  conversationId: string | undefined,
  workspacePath: string | null,
  cache?: ImageBase64Cache,
): Promise<Message[]> {
  // Fast path — skip the async fan-out unless some image was actually stripped.
  const needsWork = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'image' && !b.source.data && !!b.filePath),
  );
  if (!needsWork) return messages;

  return Promise.all(
    messages.map(async (m) => {
      if (!Array.isArray(m.content)) return m;
      let changed = false;
      const newContent = await Promise.all(
        m.content.map(async (block): Promise<MessageContent> => {
          if (block.type !== 'image' || block.source.data || !block.filePath) return block;
          changed = true;
          const data = await readImageAsBase64(conversationId, block.filePath, workspacePath, cache);
          if (data) {
            return { ...block, source: { ...block.source, data } };
          }
          // Unrecoverable — degrade to text so we never emit an empty image.
          // LLM-facing, so English like the other agent-loop prompts.
          return {
            type: 'text',
            text: `[Attached image could not be loaded (expired or missing): ${getBaseName(block.filePath)}]`,
          };
        }),
      );
      return changed ? { ...m, content: newContent } : m;
    }),
  );
}

/**
 * Single send-time entry point shared by every `adapter.chat` call site in the
 * agent loop (the primary send AND the context_too_long recovery retry). Keeps
 * the vision gate + rehydration in one place so a second send site can't silently
 * skip it (which is exactly how the recovery path regressed). Non-vision models
 * strip images downstream, so rehydration is skipped — messages pass through
 * untouched (same reference, no disk I/O).
 */
export async function rehydrateForSend(
  messages: Message[],
  opts: {
    vision: boolean;
    conversationId: string | undefined;
    workspacePath: string | null;
    cache?: ImageBase64Cache;
  },
): Promise<Message[]> {
  if (!opts.vision) return messages;
  return rehydrateImageData(messages, opts.conversationId, opts.workspacePath, opts.cache);
}
