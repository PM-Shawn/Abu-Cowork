import type { Message, MessageContent, ToolCallForContext, ToolResultContent } from '../../types';
import { createLogger } from '../logging/logger';

const logger = createLogger('imageBudget');

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
 * The same pass also enforces the other bound on old pictures: how many tool
 * calls keep their screenshots (a token budget the context manager sets from
 * context usage). Both limits drop the oldest pictures first and leave the same
 * stand-in note, so one history never carries two notes for one kind of loss.
 *
 * Determinism is a hard requirement, not a nicety. Which images get dropped is a
 * pure function of (recorded history, route policy), decided by position in the
 * traversal rather than by object identity, so replaying the same ledger rebuilds
 * the same request body byte for byte.
 */

/**
 * Model-visible stand-in for dropped images. Fixed text for a given count, since
 * anything varying (an index, a size, a filename) would make replayed requests
 * differ. It tells the model how to recover, because silently thinning the
 * history would leave it answering about a picture it can no longer see.
 */
export function omittedImagesNote(count: number): string {
  return `[${count === 1 ? 'An earlier image was' : `${count} earlier images were`} omitted from this request to keep it within the context and provider size limits. `
    + 'Read the file again if you still need to see it, or ask the user to re-attach it.]';
}

/** What to keep. Either limit may be left out. */
export interface ImageLimits {
  /** Newest tool calls that keep their images (count of calls, message images are not counted). */
  keepToolCalls?: number;
  /** Ceiling on total base64 image payload of the request. */
  maxBytes?: number;
}

/** One droppable thing, in send order: an image of a message, or all images of one tool call. */
interface Unit {
  msg: number;
  /** Index of the image block in the message content. */
  block?: number;
  /** Index of the call in the message's request-order tool call list. */
  call?: number;
  bytes: number;
}

type CallList = NonNullable<Message['toolCalls']>;

const hasId = (call: { id?: string }) => typeof call.id === 'string' && call.id.length > 0;

function imagesOf(content: readonly (MessageContent | ToolResultContent)[] | undefined) {
  return (content ?? []).filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image');
}

/**
 * The calls of one message that may be thinned: `toolCalls` (request order), or
 * `toolCallsForContext` when that is all there is. When both exist,
 * `toolCallsForContext` is what is sent (completion order), so it is thinned by
 * tool_use id alongside; a legacy message whose ids do not line up keeps that
 * list as it is rather than guessing from positions.
 */
function callsOf(message: Message, log = false): { calls: CallList; mirror?: ToolCallForContext[] } {
  const calls = (message.toolCalls ?? message.toolCallsForContext ?? []) as CallList;
  const mirror = message.toolCalls ? message.toolCallsForContext : undefined;
  if (!mirror) return { calls };
  if (!calls.every(hasId) || !mirror.every(hasId)) {
    if (log) logger.info('Skipped trimming tool call context without tool_use ids', { messageId: message.id });
    return { calls };
  }
  return { calls, mirror };
}

/** Strip the images of one call; the note goes on `result`, the string the wire reads. */
function stripImages<T extends { result?: string; resultContent?: ToolResultContent[] }>(call: T): T {
  const count = imagesOf(call.resultContent).length;
  if (count === 0) return call;
  const note = omittedImagesNote(count);
  return {
    ...call,
    result: call.result === undefined || call.result === '' ? note : `${call.result}\n\n${note}`,
    resultContent: (call.resultContent ?? []).filter((block) => block.type === 'text'),
  };
}

/**
 * Drop the oldest images of a request until it is inside both limits.
 *
 * Pass 1 lists the droppable units in send order (a message image, or the images
 * of one tool call), drops the calls beyond the newest `keepToolCalls`, then the
 * oldest remaining units until the payload fits `maxBytes`. Pass 2 applies that
 * choice by position, never by object identity: two identical images are not
 * interchangeable, and a replay must drop the same one. Calls from a sub-agent
 * are recorded for display only and never sent, so they count for nothing.
 *
 * A message image becomes a text block; a tool result cannot carry one (the wire
 * reads the `result` string and takes only image blocks from `resultContent`), so
 * the note is appended to `result`, once per call.
 *
 * @returns the original array when nothing is dropped; otherwise copies.
 */
export function dropOldImages(messages: Message[], limits: ImageLimits): Message[] {
  const units: Unit[] = [];
  messages.forEach((message, msg) => {
    if (Array.isArray(message.content)) {
      message.content.forEach((block, index) => {
        if (block.type === 'image') units.push({ msg, block: index, bytes: block.source?.data?.length ?? 0 });
      });
    }
    const { calls, mirror } = callsOf(message);
    calls.forEach((call, index) => {
      if (call.fromSubagent) return;
      // Measure what is sent: the context list's copy when there is one.
      const sent = mirror ? mirror.find((other) => other.id === call.id) : call;
      const images = imagesOf(sent?.resultContent);
      if (images.length === 0 && imagesOf(call.resultContent).length === 0) return;
      units.push({ msg, call: index, bytes: images.reduce((sum, image) => sum + (image.source?.data?.length ?? 0), 0) });
    });
  });

  const dropped = new Set<Unit>();
  if (limits.keepToolCalls !== undefined) {
    const withCalls = units.filter((unit) => unit.call !== undefined);
    withCalls.slice(0, Math.max(0, withCalls.length - limits.keepToolCalls)).forEach((unit) => dropped.add(unit));
  }
  const { maxBytes } = limits;
  if (maxBytes !== undefined && Number.isFinite(maxBytes) && maxBytes > 0) {
    let total = units.reduce((sum, unit) => sum + (dropped.has(unit) ? 0 : unit.bytes), 0);
    // A single image larger than the whole budget is dropped too: keeping it
    // would guarantee the 413 this exists to prevent.
    for (const unit of units) {
      if (total <= maxBytes) break;
      if (dropped.has(unit)) continue;
      total -= unit.bytes;
      dropped.add(unit);
    }
  }
  if (dropped.size === 0) return messages;

  return messages.map((message, msg) => {
    const mine = [...dropped].filter((unit) => unit.msg === msg);
    if (mine.length === 0) return message;
    let next = message;
    const blocks = new Set(mine.map((unit) => unit.block).filter((index) => index !== undefined));
    if (blocks.size > 0 && Array.isArray(message.content)) {
      const content = message.content.map((block, index) => (
        blocks.has(index) ? { type: 'text', text: omittedImagesNote(1) } as unknown as MessageContent : block
      ));
      next = { ...next, content };
    }
    const indices = new Set(mine.map((unit) => unit.call).filter((index) => index !== undefined));
    if (indices.size > 0) {
      const { calls, mirror } = callsOf(message, true);
      const ids = new Set(calls.filter((_, index) => indices.has(index)).map((call) => call.id));
      if (message.toolCalls) next = { ...next, toolCalls: calls.map((call, index) => (indices.has(index) ? stripImages(call) : call)) };
      if (mirror) next = { ...next, toolCallsForContext: mirror.map((call) => (ids.has(call.id!) ? stripImages(call) : call)) };
      // Only toolCallsForContext: `calls` is that list, thinned by position.
      else if (!message.toolCalls) next = { ...next, toolCallsForContext: calls.map((call, index) => (indices.has(index) ? stripImages(call) : call)) as ToolCallForContext[] };
    }
    return next;
  });
}
