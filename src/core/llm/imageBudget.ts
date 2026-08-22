import type { Message, MessageContent, ToolResultContent } from '../../types';

/**
 * Request-level image payload budget.
 *
 * Every image in a conversation is re-inlined as base64 into *every* subsequent
 * request, so a session's request body grows monotonically with each image it
 * accumulates. Once the total crosses whatever body cap sits in front of the
 * model, the request is rejected — and because the history is unchanged, every
 * retry resends the identical oversized body. The session is dead, including its
 * text-only turns, and the user has no way to recover from inside the app.
 *
 * DSH hit this in production (deepseek-harness#2644, "two screenshots was enough
 * to trigger it in the wild"); Claude Code ships dedicated recovery copy for the
 * same failure ("Accumulated images and attachments pushed the request over the
 * limit"). Gateways cap tighter than model APIs, so the ceiling is per-route —
 * see `resolveImagePolicy`.
 *
 * The fix keeps the session alive rather than reporting a cleaner error: drop the
 * OLDEST images until the request fits, leaving the newest — the ones the current
 * turn is most likely about — intact.
 *
 * Determinism is a hard requirement, not a nicety. Which images get dropped is a
 * pure function of (recorded history, route policy), decided by position in the
 * traversal rather than by object identity, so replaying the same ledger rebuilds
 * the same request body byte for byte.
 */

/**
 * Model-visible stand-in for a dropped image. Fixed text — anything varying
 * (an index, a size, a filename) would make replayed requests differ.
 *
 * It tells the model how to recover, because silently thinning the history would
 * leave it answering about a picture it can no longer see.
 */
export const OFFLOADED_IMAGE_NOTE =
  '[An earlier image was omitted to keep this request within the provider size limit. '
  + 'Read the file again if you still need to see it, or ask the user to re-attach it.]';

/**
 * Base64 payload length of one image block. Measured after rehydration, so this
 * is the exact number of bytes the image contributes to the request body — not
 * an estimate derived from the file size.
 */
function payloadLength(block: Extract<MessageContent, { type: 'image' }> | Extract<ToolResultContent, { type: 'image' }>): number {
  return block.source?.data?.length ?? 0;
}

/** Walk one content array, invoking `visit` for each image in send order. */
function eachImage(
  content: readonly (MessageContent | ToolResultContent)[] | undefined,
  visit: (length: number) => void,
): void {
  if (!content) return;
  for (const block of content) {
    if (block.type === 'image') visit(payloadLength(block));
  }
}

/**
 * Replace the next `remaining.count` images in one content array with the note.
 * Returns the original array reference when nothing in it changed, so unaffected
 * messages keep their identity and downstream `===` checks stay cheap.
 *
 * Only valid for message content, where `convertUserContent` turns a text block
 * into a real content part. Tool results take `replaceOldestInToolResult` — see
 * its comment for why a text block would be swallowed there.
 */
function replaceOldest<T extends MessageContent>(
  content: readonly T[] | undefined,
  remaining: { count: number },
): readonly T[] | undefined {
  if (!content || remaining.count === 0) return content;
  let changed = false;
  const next = content.map((block) => {
    if (block.type !== 'image' || remaining.count === 0) return block;
    remaining.count -= 1;
    changed = true;
    return { type: 'text', text: OFFLOADED_IMAGE_NOTE } as unknown as T;
  });
  return changed ? next : content;
}

/**
 * Drop the next `remaining.count` images from one tool result.
 *
 * A tool result cannot carry the note the way a message can. `normalizeMessages`
 * builds the `tool` wire message from the `result` STRING and reads
 * `resultContent` only through `extractImages`, which collects image blocks and
 * ignores everything else — so a text block left here reaches nobody and the
 * model would lose a screenshot with no explanation.
 *
 * Both DSH and Codex avoid this by deriving the tool message from its content
 * blocks (`toolResultText(result.content)` / `FunctionCallOutputContentItem`), so
 * a placeholder block is automatically on the wire. Abu's `result` string is
 * produced by `toolResultToString` from the same raw value, so folding the blocks
 * in would duplicate text it already contains. The equivalent move here is to put
 * the note where Abu's wire actually reads from: the `result` string.
 *
 * @returns the surviving blocks, and how many images this call lost.
 */
function replaceOldestInToolResult(
  content: readonly ToolResultContent[] | undefined,
  remaining: { count: number },
): { content: readonly ToolResultContent[] | undefined; dropped: number } {
  if (!content || remaining.count === 0) return { content, dropped: 0 };
  let dropped = 0;
  const next = content.filter((block) => {
    if (block.type !== 'image' || remaining.count === 0) return true;
    remaining.count -= 1;
    dropped += 1;
    return false;
  });
  return dropped > 0 ? { content: next, dropped } : { content, dropped: 0 };
}

/**
 * The tool-call list actually sent to the model. `toolCallsForContext` is the
 * canonical send representation when present and `toolCalls` is the UI fallback
 * (same rule `normalizeMessages` and `estimateMessageTokens` follow) — reading
 * both would double-count one tool exchange.
 */
function sendToolCalls(message: Message): 'toolCallsForContext' | 'toolCalls' | null {
  if (message.toolCallsForContext) return 'toolCallsForContext';
  if (message.toolCalls) return 'toolCalls';
  return null;
}

/**
 * Bound the accumulated base64 image payload of one request.
 *
 * @param messages - full send history, oldest first.
 * @param maxRequestImageBytes - ceiling on total base64 image payload.
 * @returns the original array when it already fits; otherwise copies with the
 *          oldest images replaced by {@link OFFLOADED_IMAGE_NOTE}.
 */
export function enforceImageBudget(messages: Message[], maxRequestImageBytes: number): Message[] {
  if (!Number.isFinite(maxRequestImageBytes) || maxRequestImageBytes <= 0) return messages;

  // Pass 1 — every image's contribution, in the order the provider will see them.
  const lengths: number[] = [];
  const collect = (length: number) => lengths.push(length);
  for (const message of messages) {
    if (Array.isArray(message.content)) eachImage(message.content, collect);
    const key = sendToolCalls(message);
    if (key) for (const call of message[key]!) eachImage(call.resultContent, collect);
  }

  let total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= maxRequestImageBytes) return messages;

  // Drop from the oldest until the request fits. A single image larger than the
  // whole budget is dropped too — keeping it would guarantee the 413 this exists
  // to prevent.
  let dropCount = 0;
  for (const length of lengths) {
    if (total <= maxRequestImageBytes) break;
    total -= length;
    dropCount += 1;
  }
  if (dropCount === 0) return messages;

  // Pass 2 — same traversal order, so the Nth image found here is the Nth counted
  // above. Position-based, never identity-based: two identical images are not
  // interchangeable, and a replay must drop the same one.
  const remaining = { count: dropCount };
  return messages.map((message) => {
    let next = message;

    if (Array.isArray(message.content)) {
      const content = replaceOldest(message.content, remaining);
      if (content !== message.content) next = { ...next, content: content as MessageContent[] };
    }

    const key = sendToolCalls(message);
    if (key) {
      let callsChanged = false;
      const calls = message[key]!.map((call) => {
        const { content: resultContent, dropped } = replaceOldestInToolResult(call.resultContent, remaining);
        if (dropped === 0) return call;
        callsChanged = true;
        // One note per call that lost images, not per image — still a pure
        // function of position, and N copies of the same sentence would only
        // crowd the result the model still has to read.
        const result = call.result === undefined || call.result === ''
          ? OFFLOADED_IMAGE_NOTE
          : `${call.result}\n\n${OFFLOADED_IMAGE_NOTE}`;
        return { ...call, result, resultContent: resultContent as ToolResultContent[] };
      });
      if (callsChanged) next = { ...next, [key]: calls };
    }

    return next;
  });
}
