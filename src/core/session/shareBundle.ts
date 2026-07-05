/**
 * Share Bundle — serialize a conversation into a portable `.abu.json` file
 * that another Abu user can import as a read-only dialogue.
 *
 * Responsibilities:
 *   1. Strip ephemeral / machine-local state (streaming flags, proposal
 *      signals, context caches, external references).
 *   2. Rehydrate image base64 from disk (stripForDisk clears source.data on
 *      persist, so the in-memory copy may be empty).
 *   3. Classify attachments by source via outputSnapshots manifest, and
 *      embed / skip according to the current export tier.
 *   4. Redact credentials and home-directory paths via shareRedactor.
 *
 * Tier policy (MVP only ships 'standard'; 'lite' and 'full' are reserved):
 *   - standard: embed AI-generated images & files; user-uploaded files kept as
 *     card-only (no base64 so the recipient sees the reference without the
 *     raw content).
 */

import { readFile } from '@tauri-apps/plugin-fs';
import type { Conversation, Message, MessageContent, ToolCall } from '@/types';
import { uint8ArrayToBase64 } from '@/utils/base64';
import { normalizeSeparators } from '@/utils/pathUtils';
import { listSnapshots, readSnapshotBytes, type SnapshotEntry, type SnapshotSource } from './outputSnapshots';
import { redactText, redactDeep, type RedactionSample } from './shareRedactor';

export const SHARE_SCHEMA_VERSION = 1 as const;

export type ShareTier = 'standard';

/** Per-attachment budget: anything bigger stays as a card reference only. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB
/** Total budget per bundle — cap to keep bundles emailable / pasteable. */
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

export interface ShareAttachment {
  basename: string;
  /** Redacted path (home dir collapsed to ~). */
  originalPath: string;
  source: SnapshotSource;
  mediaType?: string;
  /** Base64-encoded file contents. Absent when skipped. */
  data?: string;
  sizeBytes: number;
  /** Reason `data` is absent. */
  skipReason?: 'user-upload-excluded' | 'oversized' | 'missing' | 'snapshot-unavailable' | 'budget-exceeded';
}

export interface ShareBundle {
  schema: {
    abuShareVersion: typeof SHARE_SCHEMA_VERSION;
    tier: ShareTier;
    exportedAt: number;
  };
  conversation: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  };
  messages: Message[];
  /** Keyed by redacted originalPath. */
  attachments: Record<string, ShareAttachment>;
  stats: {
    redactionCount: number;
    attachmentCount: number;
    embeddedCount: number;
    sizeBytes: number;
  };
}

export interface BuildShareBundleOptions {
  tier?: ShareTier;
  /** Abort the build (e.g. when the preview dialog is closed). */
  signal?: AbortSignal;
  /** Progress callback over the per-message pass: (done, total). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Build a ShareBundle from an in-memory Conversation. Caller is responsible
 * for ensuring messages are loaded (e.g. by awaiting loadConversation first).
 */
export async function buildShareBundle(
  conv: Conversation,
  opts: BuildShareBundleOptions = {},
): Promise<ShareBundle> {
  const tier: ShareTier = opts.tier ?? 'standard';
  const snapshotEntries = await listSnapshots(conv.id);
  const snapshotByPath = indexByNormalizedPath(snapshotEntries);

  const redactionSamples: RedactionSample[] = [];
  let redactionCount = 0;

  // Visible (non-system) messages only — matches ChatView's `!m.isSystem`.
  const visible = conv.messages.filter((m) => !m.isSystem);
  const cleanedMessages: Message[] = [];
  let done = 0;
  for (const src of visible) {
    if (opts.signal?.aborted) throw new DOMException('share bundle build aborted', 'AbortError');
    const cleaned = await prepareMessage(src, conv.id, snapshotByPath, tier, (r) => {
      redactionCount += r.count;
      redactionSamples.push(...r.samples);
    });
    cleanedMessages.push(cleaned);
    opts.onProgress?.(++done, visible.length);
  }

  const attachments = await collectAttachments(conv.id, snapshotEntries, tier);

  const embeddedCount = Object.values(attachments).filter((a) => a.data).length;
  const bundle: ShareBundle = {
    schema: {
      abuShareVersion: SHARE_SCHEMA_VERSION,
      tier,
      exportedAt: Date.now(),
    },
    conversation: {
      id: conv.id,
      title: redactText(conv.title).text,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    },
    messages: cleanedMessages,
    attachments,
    stats: {
      redactionCount,
      attachmentCount: Object.keys(attachments).length,
      embeddedCount,
      sizeBytes: 0,
    },
  };
  bundle.stats.sizeBytes = estimateBundleSize(bundle);
  return bundle;
}

export function serializeShareBundle(bundle: ShareBundle): string {
  return JSON.stringify(bundle);
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

function indexByNormalizedPath(entries: SnapshotEntry[]): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  for (const e of entries) {
    out.set(normalizeSeparators(e.originalPath), e);
  }
  return out;
}

async function prepareMessage(
  msg: Message,
  convId: string,
  snapshotByPath: Map<string, SnapshotEntry>,
  tier: ShareTier,
  onRedaction: (r: { count: number; samples: RedactionSample[] }) => void,
): Promise<Message> {
  // Deep clone first so we never mutate the caller's object graph.
  const clone: Message = JSON.parse(JSON.stringify(msg));
  clone.isStreaming = false;
  if (clone.toolCalls) {
    for (const tc of clone.toolCalls) tc.isExecuting = false;
  }

  // Rehydrate image base64 from filePath + redact / drop per tier.
  if (Array.isArray(clone.content)) {
    const rebuilt: MessageContent[] = [];
    for (const block of clone.content as MessageContent[]) {
      if (block.type === 'image') {
        rebuilt.push(await prepareImageBlock(block, convId, snapshotByPath, tier));
      } else if (block.type === 'text') {
        const r = redactText(block.text);
        onRedaction(r);
        rebuilt.push({ type: 'text', text: r.text });
      } else {
        rebuilt.push(block);
      }
    }
    clone.content = rebuilt;
  } else if (typeof clone.content === 'string') {
    const r = redactText(clone.content);
    onRedaction(r);
    clone.content = r.text;
  }

  // Redact tool inputs / results (arbitrary shapes).
  if (clone.toolCalls && clone.toolCalls.length > 0) {
    clone.toolCalls = clone.toolCalls.map((tc) => redactToolCall(tc, onRedaction));
  }
  if (clone.toolCallsForContext && clone.toolCallsForContext.length > 0) {
    const r = redactDeep(clone.toolCallsForContext);
    onRedaction({ count: r.count, samples: r.samples });
    clone.toolCallsForContext = r.value as typeof clone.toolCallsForContext;
  }
  if (clone.thinking) {
    const r = redactText(clone.thinking);
    onRedaction(r);
    clone.thinking = r.text;
  }
  return clone;
}

async function prepareImageBlock(
  block: MessageContent & { type: 'image' },
  convId: string,
  snapshotByPath: Map<string, SnapshotEntry>,
  tier: ShareTier,
): Promise<MessageContent> {
  // Classify by manifest source when possible. Unknown origin defaults to
  // 'user-upload' under 'standard' (conservative — do not leak).
  const fp = block.filePath ? normalizeSeparators(block.filePath) : undefined;
  const entry = fp ? snapshotByPath.get(fp) : undefined;
  const source: SnapshotSource = entry?.source ?? 'user-upload';

  if (tier === 'standard' && source === 'user-upload') {
    // Strip data, keep the card-only reference.
    return {
      ...block,
      source: { ...block.source, data: '' },
      filePath: block.filePath ? redactText(block.filePath).text : undefined,
    };
  }

  // Embed base64 — prefer snapshot (stable), fall back to live filePath.
  let bytes: Uint8Array | null = null;
  if (entry?.snapshotRelPath) {
    bytes = await readSnapshotBytes(convId, entry.snapshotRelPath);
  }
  if (!bytes && block.filePath) {
    try {
      bytes = await readFile(block.filePath);
    } catch {
      bytes = null;
    }
  }

  if (!bytes) {
    // Keep the card reference even though we couldn't embed.
    return {
      ...block,
      source: { ...block.source, data: '' },
      filePath: block.filePath ? redactText(block.filePath).text : undefined,
    };
  }

  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ...block,
      source: { ...block.source, data: '' },
      filePath: block.filePath ? redactText(block.filePath).text : undefined,
    };
  }

  return {
    ...block,
    source: { ...block.source, data: uint8ArrayToBase64(bytes) },
    filePath: block.filePath ? redactText(block.filePath).text : undefined,
  };
}

function redactToolCall(
  tc: ToolCall,
  onRedaction: (r: { count: number; samples: RedactionSample[] }) => void,
): ToolCall {
  const out: ToolCall = { ...tc, isExecuting: false };
  if (out.input !== undefined) {
    const r = redactDeep(out.input);
    onRedaction({ count: r.count, samples: r.samples });
    out.input = r.value as typeof out.input;
  }
  if (typeof out.result === 'string') {
    const r = redactText(out.result);
    onRedaction(r);
    out.result = r.text;
  } else if (out.result !== undefined) {
    const r = redactDeep(out.result);
    onRedaction({ count: r.count, samples: r.samples });
    out.result = r.value as typeof out.result;
  }
  return out;
}

async function collectAttachments(
  convId: string,
  entries: SnapshotEntry[],
  tier: ShareTier,
): Promise<Record<string, ShareAttachment>> {
  const out: Record<string, ShareAttachment> = {};
  let totalEmbedded = 0;

  for (const e of entries) {
    const keyPath = redactText(e.originalPath).text;
    const base: ShareAttachment = {
      basename: e.basename,
      originalPath: keyPath,
      source: e.source,
      sizeBytes: e.size,
    };

    if (tier === 'standard' && e.source === 'user-upload') {
      out[keyPath] = { ...base, skipReason: 'user-upload-excluded' };
      continue;
    }
    if (!e.snapshotRelPath) {
      out[keyPath] = { ...base, skipReason: 'snapshot-unavailable' };
      continue;
    }
    if (e.size > MAX_ATTACHMENT_BYTES) {
      out[keyPath] = { ...base, skipReason: 'oversized' };
      continue;
    }
    if (totalEmbedded + e.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      out[keyPath] = { ...base, skipReason: 'budget-exceeded' };
      continue;
    }

    const bytes = await readSnapshotBytes(convId, e.snapshotRelPath);
    if (!bytes) {
      out[keyPath] = { ...base, skipReason: 'missing' };
      continue;
    }

    out[keyPath] = {
      ...base,
      mediaType: guessMediaType(e.basename),
      data: uint8ArrayToBase64(bytes),
    };
    totalEmbedded += bytes.length;
  }

  return out;
}

function guessMediaType(basename: string): string | undefined {
  const ext = basename.toLowerCase().split('.').pop();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
  };
  return map[ext];
}

export function estimateBundleSize(bundle: ShareBundle): number {
  // Sum component sizes directly instead of JSON.stringify-ing the whole bundle.
  // The previous body serialized every embedded base64 attachment here AND again
  // at save time (serializeShareBundle) — a double full-serialize that froze the
  // main thread on large conversations with images (Bug 2). Preview UI treats
  // this as approximate.
  let size = 0;
  for (const m of bundle.messages) {
    size += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  for (const a of Object.values(bundle.attachments)) {
    size += a.data ? a.data.length : (a.sizeBytes ?? 0);
  }
  return size;
}
