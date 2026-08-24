import type { Message, ToolCall, ToolResultContent } from '@/types';

/**
 * Durable tool results need a storage budget of their own. Request-time image
 * limits protect one provider call; these limits protect the canonical message
 * that is repeatedly serialized into the crash snapshot and JSONL ledger.
 *
 * The byte budget is measured from the actual JSON UTF-8 representation of the
 * selected ToolCall objects, not from image payload characters. This matters:
 * block envelopes, escaped Unicode/control characters, MIME metadata, `result`
 * text, and tool input are all durable bytes too.
 */
export const DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST = 8 * 1024 * 1024;
export const DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST = 8;
export const DURABLE_TOOL_RESULT_MAX_BLOCKS_PER_LIST = 64;
export const DURABLE_TOOL_RESULT_MAX_BYTES_PER_BLOCK = 6 * 1024 * 1024;
export const DURABLE_TOOL_RESULT_MAX_RESULT_BYTES = 256 * 1024;
export const DURABLE_TOOL_RESULT_MAX_INPUT_BYTES = 512 * 1024;

export interface DurableToolResultLimits {
  maxBytes: number;
  maxImages: number;
  maxBlocks?: number;
  maxBlockBytes?: number;
  maxResultBytes?: number;
  maxInputBytes?: number;
}

interface ResolvedLimits {
  maxBytes: number;
  maxImages: number;
  maxBlocks: number;
  maxBlockBytes: number;
  maxResultBytes: number;
  maxInputBytes: number;
}

const DEFAULT_LIMITS: ResolvedLimits = {
  maxBytes: DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST,
  maxImages: DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST,
  maxBlocks: DURABLE_TOOL_RESULT_MAX_BLOCKS_PER_LIST,
  maxBlockBytes: DURABLE_TOOL_RESULT_MAX_BYTES_PER_BLOCK,
  maxResultBytes: DURABLE_TOOL_RESULT_MAX_RESULT_BYTES,
  maxInputBytes: DURABLE_TOOL_RESULT_MAX_INPUT_BYTES,
};

const textEncoder = new TextEncoder();
const OMITTED_NOTE = '[Rich tool result omitted from durable history to stay within the storage budget]';
const TRUNCATED_INPUT = Object.freeze({ _durableTruncated: true });
const JSON_ARRAY_ENVELOPE_BYTES = 2;

function resolveLimits(limits: DurableToolResultLimits): ResolvedLimits {
  return {
    maxBytes: Math.max(0, Math.floor(limits.maxBytes)),
    maxImages: Math.max(0, Math.floor(limits.maxImages)),
    maxBlocks: Math.max(0, Math.floor(limits.maxBlocks ?? DEFAULT_LIMITS.maxBlocks)),
    maxBlockBytes: Math.max(0, Math.floor(limits.maxBlockBytes ?? DEFAULT_LIMITS.maxBlockBytes)),
    maxResultBytes: Math.max(0, Math.floor(limits.maxResultBytes ?? DEFAULT_LIMITS.maxResultBytes)),
    maxInputBytes: Math.max(0, Math.floor(limits.maxInputBytes ?? DEFAULT_LIMITS.maxInputBytes)),
  };
}

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

function jsonUtf8ByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : utf8ByteLength(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Check a JSON value without first allocating an attacker-sized serialized
 * string. The replacer aborts once primitive/key bytes alone cross the budget;
 * a final exact measurement includes JSON punctuation and escaping.
 */
function jsonValueFits(value: unknown, maxBytes: number): boolean {
  if (maxBytes <= 0) return false;
  const overBudget = Symbol('over-budget');
  let lowerBound = 0;
  try {
    const serialized = JSON.stringify(value, (key, current) => {
      if (key.length > maxBytes) throw overBudget;
      lowerBound += key.length + 3;
      if (typeof current === 'string') {
        if (current.length > maxBytes) throw overBudget;
        lowerBound += current.length + 2;
      } else if (current === null || typeof current !== 'object') {
        lowerBound += String(current).length;
      } else {
        // Account for at least one delimiter per array item/object member.
        lowerBound += 1;
      }
      if (lowerBound > maxBytes) throw overBudget;
      return current;
    });
    return serialized !== undefined && utf8ByteLength(serialized) <= maxBytes;
  } catch {
    return false;
  }
}

function fitJsonString(text: string, maxSerializedBytes: number): string {
  if (maxSerializedBytes <= 2) return '';
  // JSON UTF-8 bytes are never fewer than UTF-16 code units. Restricting the
  // search window avoids copying/encoding an unbounded source string.
  let low = 0;
  let high = Math.min(text.length, maxSerializedBytes);
  let best = '';
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const prefix = text.slice(0, midpoint);
    if (jsonUtf8ByteLength(prefix) <= maxSerializedBytes) {
      best = prefix;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function boundedOptionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Identity fields must remain byte-for-byte stable for append idempotency.
  // The exact enclosing-list budget below omits a call whose full identity is
  // too large instead of truncating multiple raw ids to the same prefix.
  return value;
}

function boundedToolName(value: unknown): string {
  return boundedOptionalIdentifier(value) || 'unknown_tool';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInput(value: unknown, maxBytes: number): Record<string, unknown> {
  if (!isRecord(value) || !jsonValueFits(value, maxBytes)) return TRUNCATED_INPUT;
  return value;
}

function isBase64Like(value: string): boolean {
  if (value.length === 0) return false;
  // Accept standard and URL-safe alphabets, with optional terminal padding.
  // Reject whitespace/control/Unicode and impossible one-character tails.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const unpaddedLength = value.replace(/=+$/, '').length;
  return unpaddedLength % 4 !== 1;
}

function isImageMediaType(value: string): boolean {
  return value.length <= 255 && /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value);
}

function fitTextBlock(
  text: string,
  maxBytes: number,
): Extract<ToolResultContent, { type: 'text' }> | undefined {
  const emptyBlock = { type: 'text' as const, text: '' };
  if (jsonUtf8ByteLength(emptyBlock) > maxBytes) return undefined;

  let low = 0;
  let high = Math.min(text.length, maxBytes);
  let best = '';
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const prefix = text.slice(0, midpoint);
    const candidate = { type: 'text' as const, text: prefix };
    if (jsonUtf8ByteLength(candidate) <= maxBytes) {
      best = prefix;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best.length > 0 ? { type: 'text', text: best } : undefined;
}

interface RetainedContent {
  content?: ToolResultContent[];
  omitted: boolean;
  bytes: number;
  images: number;
  blocks: number;
}

function retainContent(
  rawContent: unknown,
  availableBytes: number,
  availableImages: number,
  availableBlocks: number,
  maxBlockBytes: number,
): RetainedContent {
  if (rawContent === undefined) {
    return { content: undefined, omitted: false, bytes: 0, images: 0, blocks: 0 };
  }
  if (!Array.isArray(rawContent)) {
    return { content: undefined, omitted: true, bytes: 0, images: 0, blocks: 0 };
  }
  if (rawContent.length === 0) {
    return { content: rawContent, omitted: false, bytes: jsonUtf8ByteLength(rawContent), images: 0, blocks: 0 };
  }

  const retained: ToolResultContent[] = [];
  const scanLimit = Math.min(rawContent.length, Math.max(0, availableBlocks));
  let omitted = rawContent.length > scanLimit;
  let images = 0;
  let retainedJsonBytes = 2; // []

  for (let index = 0; index < scanLimit; index++) {
    const commaBytes = retained.length > 0 ? 1 : 0;
    const availableForBlock = Math.max(0, availableBytes - retainedJsonBytes - commaBytes);
    if (availableForBlock === 0) {
      omitted = true;
      break;
    }
    const rawBlock = rawContent[index] as unknown;
    if (!isRecord(rawBlock) || typeof rawBlock.type !== 'string') {
      omitted = true;
      continue;
    }

    let candidate: ToolResultContent | undefined;
    if (rawBlock.type === 'text') {
      if (typeof rawBlock.text !== 'string' || rawBlock.text.length === 0) {
        omitted = true;
        continue;
      }
      candidate = fitTextBlock(rawBlock.text, Math.min(maxBlockBytes, availableForBlock));
      if (!candidate || candidate.text !== rawBlock.text) omitted = true;
      else if (Object.keys(rawBlock).length === 2) candidate = rawBlock as ToolResultContent;
    } else if (rawBlock.type === 'image') {
      const source = rawBlock.source;
      if (
        !isRecord(source)
        || source.type !== 'base64'
        || typeof source.media_type !== 'string'
        || !isImageMediaType(source.media_type)
        || typeof source.data !== 'string'
        || source.data.length > maxBlockBytes
        || !isBase64Like(source.data)
      ) {
        omitted = true;
        continue;
      }
      candidate = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: source.media_type,
          data: source.data,
        },
      };
      if (Object.keys(rawBlock).length === 2 && Object.keys(source).length === 3) {
        candidate = rawBlock as ToolResultContent;
      }
      if (images >= availableImages || jsonUtf8ByteLength(candidate) > maxBlockBytes) {
        omitted = true;
        continue;
      }
    } else {
      omitted = true;
      continue;
    }

    if (!candidate) {
      omitted = true;
      continue;
    }
    const candidateBytes = jsonUtf8ByteLength(candidate);
    if (candidateBytes > availableForBlock) {
      omitted = true;
      continue;
    }
    retained.push(candidate);
    retainedJsonBytes += candidateBytes + commaBytes;
    if (candidate.type === 'image') images++;
  }

  const bytes = retained.length > 0 ? retainedJsonBytes : 0;
  const unchanged = !omitted
    && retained.length === rawContent.length
    && retained.every((block, index) => block === rawContent[index]);
  return {
    content: retained.length > 0 ? (unchanged ? rawContent as ToolResultContent[] : retained) : undefined,
    omitted,
    bytes,
    images,
    blocks: retained.length,
  };
}

function resultWithOmissionNote(source: string, maxBytes: number): string {
  if (source.includes(OMITTED_NOTE) && jsonUtf8ByteLength(source) <= maxBytes) return source;
  const separator = source.length > 0 ? '\n\n' : '';
  const suffix = `${separator}${OMITTED_NOTE}`;
  if (jsonUtf8ByteLength(suffix) > maxBytes) return fitJsonString(OMITTED_NOTE, maxBytes);

  let low = 0;
  let high = Math.min(source.length, maxBytes);
  let best = suffix;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = `${source.slice(0, midpoint)}${suffix}`;
    if (jsonUtf8ByteLength(candidate) <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function boundResult(rawResult: unknown, omitted: boolean, maxBytes: number): { result?: string; omitted: boolean } {
  const source = typeof rawResult === 'string' ? rawResult : '';
  const valid = rawResult === undefined || typeof rawResult === 'string';
  const fits = source.length <= maxBytes && jsonUtf8ByteLength(source) <= maxBytes;
  const mustNote = omitted || !valid || !fits;
  if (!mustNote) return { result: rawResult as string | undefined, omitted: false };
  return {
    result: resultWithOmissionNote(source, maxBytes),
    omitted: true,
  };
}

function withDurableResult(
  toolCall: ToolCall,
  result: string | undefined,
  resultContent: ToolResultContent[] | undefined,
): ToolCall {
  const next = { ...toolCall };
  if (result === undefined) delete next.result;
  else next.result = result;
  if (resultContent === undefined) delete next.resultContent;
  else next.resultContent = resultContent;
  return next;
}

function essentialToolCall(toolCall: ToolCall): ToolCall {
  const result = {
    name: boundedToolName(toolCall.name),
    input: toolCall.input,
  } as ToolCall;
  const id = boundedOptionalIdentifier(toolCall.id);
  if (id !== undefined) result.id = id;
  if (toolCall.result !== undefined) result.result = toolCall.result;
  if (toolCall.resultContent !== undefined) result.resultContent = toolCall.resultContent;
  if (toolCall.isExecuting !== undefined) result.isExecuting = toolCall.isExecuting;
  if (toolCall.isError !== undefined) result.isError = toolCall.isError;
  if (toolCall.startTime !== undefined) result.startTime = toolCall.startTime;
  if (toolCall.endTime !== undefined) result.endTime = toolCall.endTime;
  if (toolCall.hidden !== undefined) result.hidden = toolCall.hidden;
  if (toolCall.hideScreenshot !== undefined) result.hideScreenshot = toolCall.hideScreenshot;
  if (toolCall.fromSubagent !== undefined) result.fromSubagent = toolCall.fromSubagent;
  if (toolCall.subagentStopReason !== undefined) result.subagentStopReason = toolCall.subagentStopReason;
  if (toolCall.batchTerminalSummary !== undefined) result.batchTerminalSummary = toolCall.batchTerminalSummary;
  return result;
}

function countImages(content: ToolResultContent[] | undefined): number {
  return content?.reduce((count, block) => count + (block.type === 'image' ? 1 : 0), 0) ?? 0;
}

interface BoundedCall {
  toolCall?: ToolCall;
  bytes: number;
  images: number;
  blocks: number;
}

function fitToolCallToBudget(
  rawToolCall: ToolCall,
  availableBytes: number,
  availableImages: number,
  availableBlocks: number,
  limits: ResolvedLimits,
): BoundedCall {
  const input = boundedInput(rawToolCall.input, Math.min(limits.maxInputBytes, availableBytes));
  const base: ToolCall = {
    ...rawToolCall,
    name: boundedToolName(rawToolCall.name),
    input,
  };
  const id = boundedOptionalIdentifier(rawToolCall.id);
  if (id === undefined) delete (base as Partial<ToolCall>).id;
  else base.id = id;
  const retained = retainContent(
    rawToolCall.resultContent,
    availableBytes,
    availableImages,
    availableBlocks,
    Math.min(limits.maxBlockBytes, availableBytes),
  );
  let boundedResult = boundResult(rawToolCall.result, retained.omitted, limits.maxResultBytes);
  let candidate = withDurableResult(base, boundedResult.result, retained.content);
  const initiallyUnchanged = base.id === rawToolCall.id
    && base.name === rawToolCall.name
    && input === rawToolCall.input
    && boundedResult.result === rawToolCall.result
    && retained.content === rawToolCall.resultContent;
  let reduced = false;

  const measure = (call: ToolCall): number => (
    jsonValueFits(call, availableBytes) ? jsonUtf8ByteLength(call) : Number.POSITIVE_INFINITY
  );
  let bytes = measure(candidate);

  // Preserve as many leading blocks as fit. Block count is globally capped, so
  // this loop is bounded and its exact JSON measurements cannot be attacker-sized.
  if (bytes > availableBytes && candidate.resultContent?.length) {
    const content = [...candidate.resultContent];
    while (bytes > availableBytes && content.length > 0) {
      reduced = true;
      content.pop();
      boundedResult = boundResult(rawToolCall.result, true, limits.maxResultBytes);
      candidate = withDurableResult(base, boundedResult.result, content.length > 0 ? content : undefined);
      bytes = measure(candidate);
    }
  }

  if (bytes > availableBytes) {
    // Bulky optional UI metadata must not bypass the canonical list budget.
    candidate = essentialToolCall(candidate);
    reduced = true;
    bytes = measure(candidate);
  }

  if (bytes > availableBytes) {
    candidate = withDurableResult(candidate, resultWithOmissionNote('', limits.maxResultBytes), undefined);
    reduced = true;
    bytes = measure(candidate);
  }

  if (bytes > availableBytes && candidate.input !== TRUNCATED_INPUT) {
    candidate = { ...candidate, input: TRUNCATED_INPUT };
    reduced = true;
    bytes = measure(candidate);
  }

  if (bytes > availableBytes) {
    // A selected call whose minimal, bounded skeleton cannot fit is omitted.
    // Newest calls were processed first, so this degrades oldest history first.
    return { bytes: 0, images: 0, blocks: 0 };
  }

  return {
    toolCall: initiallyUnchanged && !reduced ? rawToolCall : candidate,
    bytes,
    images: countImages(candidate.resultContent),
    blocks: candidate.resultContent?.length ?? 0,
  };
}

/**
 * Retain the newest selected tool calls within a deterministic, exact JSON
 * budget. Non-selected calls are left untouched and do not consume this
 * budget; the append admission path uses that to bound only hidden subagent
 * replay entries, while the disk boundary selects every call.
 */
export function boundToolCallRichContent(
  toolCalls: ToolCall[] | undefined,
  limits: DurableToolResultLimits = DEFAULT_LIMITS,
  predicate: (toolCall: ToolCall) => boolean = () => true,
): ToolCall[] | undefined {
  if (!toolCalls?.length) return toolCalls;
  const resolved = resolveLimits(limits);
  let remainingBytes = Math.max(0, resolved.maxBytes - JSON_ARRAY_ENVELOPE_BYTES);
  let remainingImages = resolved.maxImages;
  let remainingBlocks = resolved.maxBlocks;
  let selectedRetained = 0;
  let changed = false;
  const bounded: Array<ToolCall | undefined> = [...toolCalls];

  for (let index = toolCalls.length - 1; index >= 0; index--) {
    const toolCall = toolCalls[index];
    if (!predicate(toolCall)) continue;
    const commaBytes = selectedRetained > 0 ? 1 : 0;
    const fitted = fitToolCallToBudget(
      toolCall,
      Math.max(0, remainingBytes - commaBytes),
      remainingImages,
      remainingBlocks,
      resolved,
    );
    if (!fitted.toolCall) {
      bounded[index] = undefined;
      changed = true;
      continue;
    }
    remainingBytes -= fitted.bytes + commaBytes;
    remainingImages -= fitted.images;
    remainingBlocks -= fitted.blocks;
    selectedRetained++;
    if (fitted.toolCall !== toolCall) {
      bounded[index] = fitted.toolCall;
      changed = true;
    }
  }

  return changed ? bounded.filter((toolCall): toolCall is ToolCall => toolCall !== undefined) : toolCalls;
}

/** Canonical disk-boundary defense for both UI and LLM-context projections. */
export function boundMessageToolResultContentForDisk(message: Message): Message {
  const toolCalls = boundToolCallRichContent(message.toolCalls);
  const contextCalls = boundToolCallRichContent(message.toolCallsForContext as ToolCall[] | undefined);
  if (toolCalls === message.toolCalls && contextCalls === message.toolCallsForContext) return message;
  return {
    ...message,
    toolCalls,
    toolCallsForContext: contextCalls as Message['toolCallsForContext'],
  };
}

/**
 * Canonical admission boundary for hidden subagent replay entries. It keeps
 * dual sidecar/shell delivery idempotent and evicts older replay calls before
 * the growing parent message can amplify stream-snapshot writes.
 */
export function appendBoundedSubagentToolCall(
  existing: ToolCall[] | undefined,
  incoming: ToolCall,
  limits: DurableToolResultLimits = DEFAULT_LIMITS,
): { toolCalls: ToolCall[]; appended: boolean } {
  const current = existing ?? [];
  if (current.some((toolCall) => toolCall.id === incoming.id)) {
    return { toolCalls: current, appended: false };
  }
  const appended = [...current, incoming];
  return {
    toolCalls: boundToolCallRichContent(
      appended,
      limits,
      (toolCall) => toolCall.fromSubagent === true,
    ) ?? appended,
    appended: true,
  };
}

export const __testing = {
  OMITTED_NOTE,
  jsonUtf8ByteLength,
  jsonValueFits,
  retainContent,
};
