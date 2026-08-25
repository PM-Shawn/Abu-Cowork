import type { Message, MessageContent, ToolCall, ToolCallForContext, ToolResultContent, ToolResultOutputRef } from '../../types';
import { resolveFileSource, resolveOutputRefSource } from '../session/outputSnapshots';
import { uint8ArrayToBase64 } from '../../utils/base64';
import { getBaseName } from '../../utils/pathUtils';
import { createLogger } from '../logging/logger';
import { enforceImageBudget } from './imageBudget';

const logger = createLogger('imageRehydration');

/** Cache of image identity → base64 (or null when unrecoverable) for the lifetime of
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
  const cacheKey = `file:${filePath}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;
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
  cache?.set(cacheKey, result);
  return result;
}

async function readOutputRefAsBase64(
  conversationId: string | undefined,
  outputRef: ToolResultOutputRef,
  cache?: ImageBase64Cache,
): Promise<string | null> {
  const cacheKey = `output:${conversationId ?? ''}:${outputRef.relPath}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;
  let result: string | null = null;
  try {
    const resolved = await resolveOutputRefSource(conversationId, outputRef.relPath);
    if (resolved.status === 'available') {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const bytes = await readFile(resolved.path);
      result = uint8ArrayToBase64(bytes);
    }
  } catch (e) {
    logger.warn('tool result image rehydrate failed', { relPath: outputRef.relPath, err: String(e) });
    result = null;
  }
  cache?.set(cacheKey, result);
  return result;
}

function formatOutputRefPlaceholder(outputRef: ToolResultOutputRef, mediaType: string): string {
  const metadata = [
    `path=${outputRef.relPath}`,
    outputRef.basename ? `filename=${outputRef.basename}` : null,
    outputRef.sizeBytes !== undefined ? `bytes=${outputRef.sizeBytes}` : null,
    `media_type=${mediaType}`,
  ].filter(Boolean).join(', ');
  return `[Tool result image could not be loaded for send (${metadata}).]`;
}

async function rehydrateToolResultContent(
  resultContent: ToolResultContent[] | undefined,
  conversationId: string | undefined,
  cache?: ImageBase64Cache,
): Promise<{ content: ToolResultContent[] | undefined; changed: boolean; missingNotes: string[] }> {
  if (!resultContent?.some((block) => block.type === 'image' && !block.source.data && !!block.outputRef?.relPath)) {
    return { content: resultContent, changed: false, missingNotes: [] };
  }

  let changed = false;
  const missingNotes: string[] = [];
  const content = (await Promise.all(
    resultContent.map(async (block): Promise<ToolResultContent | null> => {
      if (block.type !== 'image' || block.source.data || !block.outputRef?.relPath) return block;
      changed = true;
      const data = await readOutputRefAsBase64(conversationId, block.outputRef, cache);
      if (data) {
        return { ...block, source: { ...block.source, data }, outputRef: { ...block.outputRef } };
      }
      missingNotes.push(formatOutputRefPlaceholder(block.outputRef, block.source.media_type));
      return null;
    }),
  )).filter((block): block is ToolResultContent => block !== null);

  return { content, changed, missingNotes };
}

function appendSendOnlyNotes(result: string | undefined, notes: string[]): string | undefined {
  if (notes.length === 0) return result;
  const noteText = notes.join('\n');
  return result ? `${result}\n\n${noteText}` : noteText;
}

// messageNormalizer sends `toolCallsForContext || toolCalls`; hydrate both
// carriers so whichever copy wins that outbound priority has equivalent image
// bytes or the same reversible missing-file note in `result`.
async function rehydrateToolCalls<T extends ToolCall | ToolCallForContext>(
  calls: T[] | undefined,
  conversationId: string | undefined,
  cache?: ImageBase64Cache,
): Promise<{ calls: T[] | undefined; changed: boolean }> {
  if (!calls?.some((call) => call.resultContent?.some(
    (block) => block.type === 'image' && !block.source.data && !!block.outputRef?.relPath,
  ))) {
    return { calls, changed: false };
  }

  let changed = false;
  const nextCalls = await Promise.all(
    calls.map(async (call): Promise<T> => {
      const result = await rehydrateToolResultContent(call.resultContent, conversationId, cache);
      if (!result.changed) return call;
      changed = true;
      return {
        ...call,
        result: appendSendOnlyNotes(call.result, result.missingNotes),
        resultContent: result.content,
      } as T;
    }),
  );

  return { calls: nextCalls, changed };
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
 * User attachments are re-read from `filePath` (or its snapshot) and degrade to
 * a text content block when missing. Tool-result images are re-read from their
 * exact `outputRef`; a missing file removes the unsendable image and appends a
 * send-only note to the tool call's `result`, which is the carrier consumed by
 * `normalizeMessages`. Neither path can emit an empty base64 image.
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
      (Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'image' && !b.source.data && !!b.filePath))
      || m.toolCalls?.some((call) => call.resultContent?.some(
        (b) => b.type === 'image' && !b.source.data && !!b.outputRef?.relPath,
      ))
      || m.toolCallsForContext?.some((call) => call.resultContent?.some(
        (b) => b.type === 'image' && !b.source.data && !!b.outputRef?.relPath,
      )),
  );
  if (!needsWork) return messages;

  return Promise.all(
    messages.map(async (m) => {
      let changed = false;
      let next: Message = m;

      if (Array.isArray(m.content)) {
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
        if (changed) next = { ...next, content: newContent };
      }

      const toolCalls = await rehydrateToolCalls(m.toolCalls, conversationId, cache);
      if (toolCalls.changed) {
        next = { ...next, toolCalls: toolCalls.calls as ToolCall[] };
        changed = true;
      }

      const toolCallsForContext = await rehydrateToolCalls(m.toolCallsForContext, conversationId, cache);
      if (toolCallsForContext.changed) {
        next = { ...next, toolCallsForContext: toolCallsForContext.calls as ToolCallForContext[] };
        changed = true;
      }

      return changed ? next : m;
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
    /** Route's ceiling on total base64 image payload (`resolveImagePolicy`).
     *  Omitted → no budget is applied (the pre-policy behaviour). */
    maxRequestImageBytes?: number;
  },
): Promise<Message[]> {
  if (!opts.vision) return messages;
  const rehydrated = await rehydrateImageData(messages, opts.conversationId, opts.workspacePath, opts.cache);
  // Budget AFTER rehydration, and inside this seam rather than beside it.
  //
  // After, because only rehydrated blocks carry their real base64 — measuring
  // here bounds the actual request body instead of estimating from file sizes,
  // and unrecoverable images have already collapsed to text placeholders.
  //
  // Inside, because this function exists precisely so a second send site cannot
  // silently skip the send-prep step (see this file's header — that is how the
  // recovery retry regressed once already). A sibling call in agentLoop would
  // reintroduce that trap for the next person.
  if (opts.maxRequestImageBytes === undefined) return rehydrated;
  return enforceImageBudget(rehydrated, opts.maxRequestImageBytes);
}
