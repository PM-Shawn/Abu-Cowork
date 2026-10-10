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
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import { extractFileOutputs } from '@/utils/workflowExtractor';
import { expandTilde, listSnapshots, readSnapshotBytes, type SnapshotEntry, type SnapshotSource } from './outputSnapshots';
import { redactText, redactDeep, type RedactionSample } from './shareRedactor';
import { isCompactBoundary } from '@/core/context/compactBoundary';
import { isBrowserRunReportMessage } from '@/core/observability/browserRunReport';
import { isMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import { normalizeUpstreamErrorDetails, sanitizeUntrustedLlmErrorText } from '@/core/llm/adapter';

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
  // Also drop compact-boundary markers: they render as an in-app divider (not
  // a real message), carry empty content, and their compactBoundary.summaryText
  // is a summary of the whole conversation that redactText would NOT scrub (it
  // only scrubs `content`) — dropping them avoids leaking an un-redacted
  // summary. The summarized messages themselves are still present and redacted.
  // Unattended run report cards (U7) are dropped for the SAME reason: they
  // render as a card rather than a message, carry empty `content`, and their
  // payload holds the origins the run visited — internal hostnames that
  // `redactText` never sees, because it only scrubs `content`. Sharing a
  // conversation must not leak an intranet host list.
  // Turn-cap notices are dropped for the first half of that reason only: they
  // render as a card and carry empty `content`, so exporting one would put a
  // blank bubble in the bundle. Their payload is two numbers — nothing to leak.
  const visible = conv.messages.filter(
    (m) => !m.isSystem
      && !isCompactBoundary(m)
      && !isBrowserRunReportMessage(m)
      && !isMaxTurnsNoticeMessage(m),
  );
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

  const references = await collectExportedReferences(visible, conv.workspacePath);
  const attachments = await collectAttachments(conv.id, snapshotEntries, tier, references);

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
  if (clone.runState !== 'failed' && clone.runState !== 'connection-failed') {
    delete clone.runError;
    delete clone.runErrorDetails;
  }
  if (clone.runError) {
    const r = redactText(clone.runError);
    onRedaction(r);
    clone.runError = sanitizeUntrustedLlmErrorText(r.text, 'Provider request failed');
  }
  const runErrorDetails = normalizeUpstreamErrorDetails(clone.runErrorDetails);
  if (!runErrorDetails) {
    delete clone.runErrorDetails;
  } else {
    const redactOptionalField = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      const redacted = redactText(value);
      onRedaction(redacted);
      return redacted.text;
    };
    // Every provider-controlled string can echo credentials, including fields
    // normally used as identifiers. Re-normalize after redaction so a replaced
    // value can never escape the bounded share-contract projection.
    const redactedDetails = normalizeUpstreamErrorDetails({
      status: runErrorDetails.status,
      error_type: redactOptionalField(runErrorDetails.error_type),
      traceId: redactOptionalField(runErrorDetails.traceId),
      summary: redactOptionalField(runErrorDetails.summary),
    });
    if (redactedDetails) clone.runErrorDetails = redactedDetails;
    else delete clone.runErrorDetails;
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

/**
 * What the exported messages refer to. An attachment goes out only when one
 * of these ties it to a message that is in the bundle.
 */
interface ExportedReferences {
  messageIds: Set<string>;
  toolCallIds: Set<string>;
  /** Raw message text, for a code save whose file is the text of a code block. */
  texts: string[];
  /** Normalized paths the messages name as written outputs or attached images. */
  paths: Set<string>;
}

async function collectExportedReferences(
  messages: Message[],
  workspacePath: string | null | undefined,
): Promise<ExportedReferences> {
  const refs: ExportedReferences = {
    messageIds: new Set(),
    toolCallIds: new Set(),
    texts: [],
    paths: new Set(),
  };
  const addPath = async (raw: string): Promise<void> => {
    const resolved = workspacePath && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(raw) ? joinPath(workspacePath, raw) : raw;
    refs.paths.add(normalizeSeparators(await expandTilde(resolved)).replace(/\/+$/, ''));
  };
  for (const m of messages) {
    refs.messageIds.add(m.id);
    if (typeof m.content === 'string') {
      refs.texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content as MessageContent[]) {
        if (block.type === 'text') refs.texts.push(block.text);
        else if (block.type === 'image' && block.filePath) await addPath(block.filePath);
      }
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) refs.toolCallIds.add(tc.id);
      const outputs = extractFileOutputs(m.toolCalls, { mode: 'deliverables', includeReads: false });
      for (const o of outputs) {
        if (o.operation === 'create' || o.operation === 'write') await addPath(o.path);
      }
    }
  }
  return refs;
}

/**
 * Whether an exported message accounts for this manifest entry. A tool output
 * is tied by its tool call id, a user upload by its message id, an entry
 * installed from an imported bundle by a path a message names, and a code
 * save by its text appearing in a message; the last needs the file's bytes.
 */
function isReferencedByExport(entry: SnapshotEntry, refs: ExportedReferences, bytes: Uint8Array | null): boolean {
  if (entry.source === 'code-save') {
    if (!bytes || bytes.length === 0) return false;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return refs.texts.some((t) => t.includes(text));
  }
  if (entry.refId === 'shared-import') return refs.paths.has(entry.originalPath);
  if (entry.source === 'tool-output') return refs.toolCallIds.has(entry.refId);
  return refs.messageIds.has(entry.refId);
}

async function collectAttachments(
  convId: string,
  entries: SnapshotEntry[],
  tier: ShareTier,
  refs: ExportedReferences,
): Promise<Record<string, ShareAttachment>> {
  const out: Record<string, ShareAttachment> = {};
  let totalEmbedded = 0;

  for (const e of entries) {
    // A code save is confirmed by its bytes, read below; every other entry is
    // settled here, before anything is read for it.
    const confirmedByBytes = e.source === 'code-save';
    if (!confirmedByBytes && !isReferencedByExport(e, refs, null)) continue;

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
      if (confirmedByBytes) continue;
      out[keyPath] = { ...base, skipReason: 'snapshot-unavailable' };
      continue;
    }
    if (e.size > MAX_ATTACHMENT_BYTES) {
      if (confirmedByBytes) continue;
      out[keyPath] = { ...base, skipReason: 'oversized' };
      continue;
    }
    if (totalEmbedded + e.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      if (confirmedByBytes) continue;
      out[keyPath] = { ...base, skipReason: 'budget-exceeded' };
      continue;
    }

    const bytes = await readSnapshotBytes(convId, e.snapshotRelPath);
    if (!bytes) {
      if (confirmedByBytes) continue;
      out[keyPath] = { ...base, skipReason: 'missing' };
      continue;
    }
    if (confirmedByBytes && !isReferencedByExport(e, refs, bytes)) continue;

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
