import type { ToolCall, ToolResultContent } from '@/types';
import {
  boundToolCallRichContent,
  DURABLE_TOOL_RESULT_MAX_BLOCKS_PER_LIST,
  DURABLE_TOOL_RESULT_MAX_BYTES_PER_BLOCK,
  DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST,
  DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST,
} from '@/core/session/durableToolResultContent';

/**
 * Active-run rich results use the same shape and per-block policy as durable
 * history, but account only the retained resultContent JSON. Tool-call pairing
 * fields stay outside this budget and are never evicted by this ledger.
 */
export const ACTIVE_TOOL_RESULT_MAX_BYTES_PER_RUN = DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST;
export const ACTIVE_TOOL_RESULT_MAX_IMAGES_PER_RUN = DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST;
export const ACTIVE_TOOL_RESULT_MAX_BLOCKS_PER_RUN = DURABLE_TOOL_RESULT_MAX_BLOCKS_PER_LIST;
export const ACTIVE_TOOL_RESULT_MAX_BYTES_PER_BLOCK = DURABLE_TOOL_RESULT_MAX_BYTES_PER_BLOCK;

export interface ActiveToolResultLimits {
  maxBytes: number;
  maxImages: number;
  maxBlocks: number;
  maxBlockBytes: number;
}

export interface ActiveToolResultToken {
  readonly id: number;
}

export interface ActiveToolResultDiagnostics {
  bytes: number;
  images: number;
  blocks: number;
  entries: number;
}

interface ActiveEntry {
  token: InternalToken;
  content: ToolResultContent[];
  bytes: number;
  images: number;
  blocks: number;
  release?: () => void;
}

interface InternalToken extends ActiveToolResultToken {
  entry?: ActiveEntry;
  released: boolean;
}

const DEFAULT_LIMITS: ActiveToolResultLimits = {
  maxBytes: ACTIVE_TOOL_RESULT_MAX_BYTES_PER_RUN,
  maxImages: ACTIVE_TOOL_RESULT_MAX_IMAGES_PER_RUN,
  maxBlocks: ACTIVE_TOOL_RESULT_MAX_BLOCKS_PER_RUN,
  maxBlockBytes: ACTIVE_TOOL_RESULT_MAX_BYTES_PER_BLOCK,
};

const textEncoder = new TextEncoder();
const SYNTHETIC_CALL: ToolCall = { id: 'active', name: 'active', input: {} };
const SYNTHETIC_CONTENT_WRAPPER_BYTES = jsonUtf8Bytes([{ ...SYNTHETIC_CALL, resultContent: [] }])
  - jsonUtf8Bytes([]);

function jsonUtf8Bytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : textEncoder.encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveLimits(limits: Partial<ActiveToolResultLimits>): ActiveToolResultLimits {
  return {
    maxBytes: normalizeLimit(limits.maxBytes ?? DEFAULT_LIMITS.maxBytes),
    maxImages: normalizeLimit(limits.maxImages ?? DEFAULT_LIMITS.maxImages),
    maxBlocks: normalizeLimit(limits.maxBlocks ?? DEFAULT_LIMITS.maxBlocks),
    maxBlockBytes: normalizeLimit(limits.maxBlockBytes ?? DEFAULT_LIMITS.maxBlockBytes),
  };
}

function countImages(content: ToolResultContent[]): number {
  return content.reduce((count, block) => count + (block.type === 'image' ? 1 : 0), 0);
}

/**
 * Canonicalize one untrusted runtime result through the established durable
 * validator. The synthetic wrapper allowance ensures its ToolCall envelope is
 * not charged to the active resultContent byte budget.
 */
export function canonicalizeActiveToolResultContent(
  rawContent: unknown,
  limits: Partial<ActiveToolResultLimits> = DEFAULT_LIMITS,
): ToolResultContent[] | undefined {
  const resolved = resolveLimits(limits);
  if (rawContent === undefined || resolved.maxBytes === 0 || resolved.maxBlocks === 0) return undefined;
  const candidate: ToolCall = {
    ...SYNTHETIC_CALL,
    resultContent: rawContent as ToolResultContent[],
  };
  const bounded = boundToolCallRichContent([candidate], {
    maxBytes: resolved.maxBytes + SYNTHETIC_CONTENT_WRAPPER_BYTES,
    maxImages: resolved.maxImages,
    maxBlocks: resolved.maxBlocks,
    maxBlockBytes: resolved.maxBlockBytes,
    maxResultBytes: 0,
    maxInputBytes: 2,
  });
  const content = bounded?.[0]?.resultContent;
  if (!content?.length || jsonUtf8Bytes(content) > resolved.maxBytes) return undefined;
  return content;
}

/**
 * Newest-first per-run admission. Eviction invokes an owner callback that must
 * delete only resultContent/imageData, leaving tool ids, inputs and results in
 * place so provider tool_use/tool_result pairing remains intact.
 */
export class ActiveToolResultAdmission {
  private readonly limits: ActiveToolResultLimits;
  private readonly entries: ActiveEntry[] = [];
  private nextId = 0;
  private bytes = 0;
  private images = 0;
  private blocks = 0;

  constructor(limits: Partial<ActiveToolResultLimits> = DEFAULT_LIMITS) {
    this.limits = resolveLimits(limits);
  }

  admit(rawContent: unknown): ActiveToolResultToken | undefined {
    const content = canonicalizeActiveToolResultContent(rawContent, this.limits);
    if (!content) return undefined;
    const bytes = jsonUtf8Bytes(content);
    const images = countImages(content);
    const blocks = content.length;
    if (bytes > this.limits.maxBytes
      || images > this.limits.maxImages
      || blocks > this.limits.maxBlocks) {
      return undefined;
    }

    const token: InternalToken = { id: ++this.nextId, released: false };
    const entry: ActiveEntry = { token, content, bytes, images, blocks };
    token.entry = entry;
    this.entries.push(entry);
    this.bytes += bytes;
    this.images += images;
    this.blocks += blocks;
    this.evictOldestUntilBounded();
    return token.entry ? token : undefined;
  }

  get(token: ActiveToolResultToken | undefined): ToolResultContent[] | undefined {
    return (token as InternalToken | undefined)?.entry?.content;
  }

  bindRelease(token: ActiveToolResultToken | undefined, release: () => void): void {
    if (!token) return;
    const internal = token as InternalToken;
    if (internal.released || !internal.entry) {
      release();
      return;
    }
    internal.entry.release = release;
  }

  /**
   * Explicitly retire an admitted owner before replacing its payload. The
   * callback runs after ledger accounting is removed, so a re-entrant owner
   * mutation cannot leave diagnostics above the configured hard bound.
   */
  release(token: ActiveToolResultToken | undefined): void {
    const entry = (token as InternalToken | undefined)?.entry;
    if (entry) this.releaseEntry(entry);
  }

  diagnostics(): ActiveToolResultDiagnostics {
    return {
      bytes: this.bytes,
      images: this.images,
      blocks: this.blocks,
      entries: this.entries.length,
    };
  }

  private evictOldestUntilBounded(): void {
    while (this.bytes > this.limits.maxBytes
      || this.images > this.limits.maxImages
      || this.blocks > this.limits.maxBlocks) {
      const oldest = this.entries[0];
      if (!oldest) break;
      this.releaseEntry(oldest);
    }
  }

  private releaseEntry(entry: ActiveEntry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.bytes -= entry.bytes;
    this.images -= entry.images;
    this.blocks -= entry.blocks;
    entry.token.entry = undefined;
    entry.token.released = true;
    entry.release?.();
  }
}
