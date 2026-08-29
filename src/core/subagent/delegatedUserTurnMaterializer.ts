import type { Conversation, DocumentContent, ImageContent, Message, MessageContent, ToolCall, ToolCallForContext, ToolResult, ToolResultContent } from '../../types';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../../utils/base64';
import { getConversationReader } from '../agent/ports/conversationReader';
import { readRecoverableImageBytes } from '../llm/imageRehydration';
import { redactSensitiveMediaText } from '../security/redaction';
import {
  persistDelegatedMedia,
  readDelegatedMedia,
} from './delegatedMediaStore';
import {
  DELEGATED_USER_TURN_SCHEMA_VERSION,
  isDelegatedUserTurn,
  isDelegatedMediaType,
  isOpaqueMediaId,
  isStrictMediaRef,
  type DelegatedContentBlock,
  type DelegatedUserTurn,
  type MediaRef,
} from './delegatedUserTurn';
import {
  DELEGATED_TEXT_ONLY_IMAGE_PLACEHOLDER,
  MAX_DELEGATED_IMAGE_BASE64_BYTES,
  MAX_DELEGATED_IMAGE_COUNT,
} from './delegatedMediaPreflight';

export class DelegatedUserTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegatedUserTurnError';
  }
}

type MaterializeInput = Readonly<{
  conversationId: string;
  loopId: string;
  signal?: AbortSignal;
}>;

type BuildInitialContentInput = Readonly<{
  task: string;
  context?: string;
  delegatedUserTurn?: DelegatedUserTurn;
  imageDisposition?: 'send' | 'text-only';
}>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function taskWithContext(task: string, context: string | undefined): string {
  return context ? `${task}\n\n${context}` : task;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: aborted');
  }
}

function abortError(phase: 'materialize' | 'prepare'): DelegatedUserTurnError {
  return new DelegatedUserTurnError(`Cannot ${phase} delegated user turn: aborted`);
}

function persistDelegatedMediaAbortable(
  conversationId: string,
  input: Parameters<typeof persistDelegatedMedia>[1],
  signal: AbortSignal | undefined,
): Promise<MediaRef> {
  return signal
    ? persistDelegatedMedia(conversationId, input, signal)
    : persistDelegatedMedia(conversationId, input);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError('prepare'));
  void promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError('prepare'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function inlineBase64PayloadLength(data: string): number {
  return data.replace(/\s/g, '').length;
}

function assertInlineImageBudgetBeforeRead(content: readonly MessageContent[]): void {
  const imageBlocks = content.filter((block): block is ImageContent => block.type === 'image');
  if (imageBlocks.length > MAX_DELEGATED_IMAGE_COUNT) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: too many images');
  }
  let total = 0;
  for (const image of imageBlocks) {
    if (!image.source.data) continue;
    const encodedLength = inlineBase64PayloadLength(image.source.data);
    if (encodedLength > MAX_DELEGATED_IMAGE_BASE64_BYTES) {
      throw new DelegatedUserTurnError('Cannot materialize delegated user turn: image is too large');
    }
    total += encodedLength;
  }
  if (total > MAX_DELEGATED_IMAGE_BASE64_BYTES * 3) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: images are too large');
  }
}


function decodeInlineBytes(data: string, kind: 'image' | 'document'): Uint8Array {
  if (!data) {
    throw new DelegatedUserTurnError(`Cannot materialize delegated ${kind}: missing inline data`);
  }
  try {
    const bytes = base64ToUint8Array(data);
    if (bytes.byteLength <= 0) {
      throw new Error('empty payload');
    }
    return bytes;
  } catch {
    throw new DelegatedUserTurnError(`Cannot materialize delegated ${kind}: corrupt inline data`);
  }
}

async function readStrippedImageBytes(
  conversationId: string,
  image: ImageContent,
  workspacePath: string | null | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!image.filePath) {
    throw new DelegatedUserTurnError('Cannot materialize delegated image: stored pixels are unavailable');
  }
  const bytes = await raceAbort(
    readRecoverableImageBytes(conversationId, image.filePath, workspacePath ?? null),
    signal,
  );
  throwIfAborted(signal);
  if (!bytes) {
    throw new DelegatedUserTurnError('Cannot materialize delegated image: stored pixels are unavailable');
  }
  return bytes;
}

async function materializeImageBlock(
  conversationId: string,
  image: ImageContent,
  workspacePath: string | null | undefined,
  signal: AbortSignal | undefined,
): Promise<DelegatedContentBlock> {
  const mediaType = image.source.media_type;
  if (!isDelegatedMediaType(mediaType) || !mediaType.startsWith('image/')) {
    throw new DelegatedUserTurnError('Cannot materialize delegated image: unsupported media type');
  }
  const bytes = image.source.data
    ? decodeInlineBytes(image.source.data, 'image')
    : await readStrippedImageBytes(conversationId, image, workspacePath, signal);
  throwIfAborted(signal);
  const attachment = await raceAbort(
    persistDelegatedMediaAbortable(conversationId, { mediaType, bytes }, signal),
    signal,
  );
  return deepFreeze({ type: 'image', attachment });
}

async function materializeDocumentBlock(
  conversationId: string,
  document: DocumentContent,
  signal: AbortSignal | undefined,
): Promise<DelegatedContentBlock> {
  const mediaType = document.source.media_type;
  if (mediaType !== 'application/pdf') {
    throw new DelegatedUserTurnError('Cannot materialize delegated document: unsupported media type');
  }
  if (document.originConversationId !== undefined && document.originConversationId !== conversationId) {
    throw new DelegatedUserTurnError('Cannot materialize delegated document: media origin mismatch');
  }
  const bytes = decodeInlineBytes(document.source.data, 'document');
  const attachment = await raceAbort(
    persistDelegatedMediaAbortable(conversationId, { mediaType, bytes }, signal),
    signal,
  );
  return deepFreeze({ type: 'document', attachment, ...(document.name ? { name: document.name } : {}) });
}

/**
 * The trusted shell seam for multimodal delegation.
 *
 * Callers may provide only shell-owned conversation/loop identity. The source
 * message id, content order, bytes, and any disk recovery path are derived from
 * the current conversation record, never from model/tool arguments.
 */
export async function materializeDelegatedUserTurn(
  input: MaterializeInput,
): Promise<DelegatedUserTurn> {
  throwIfAborted(input.signal);
  const conversation = getConversationReader().getConversation(input.conversationId);
  if (!conversation) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: conversation not found');
  }
  if (conversation.id !== input.conversationId) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: conversation identity mismatch');
  }
  const sourceMessages = conversation.messages.filter(
    (message): message is Message =>
      message.role === 'user'
      && message.isSystem !== true
      && message.loopId === input.loopId,
  );
  if (sourceMessages.length !== 1) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: source user turn is missing or ambiguous');
  }

  const sourceMessage = sourceMessages[0];
  const sourceContent = sourceMessage.content;
  const content: DelegatedContentBlock[] = [];
  if (typeof sourceContent === 'string') {
    content.push({ type: 'text', text: sourceContent });
  } else {
    assertInlineImageBudgetBeforeRead(sourceContent);
    for (const block of sourceContent) {
      throwIfAborted(input.signal);
      const internalBlock: unknown = block;
      if (isDelegatedRefContent(internalBlock)) {
        if (internalBlock.originConversationId !== input.conversationId) {
          throw new DelegatedUserTurnError('Cannot materialize delegated user turn: media origin mismatch');
        }
        if (internalBlock.attachment.mediaType.startsWith('image/')) {
          content.push({ type: 'image', attachment: internalBlock.attachment });
        } else if (internalBlock.attachment.mediaType === 'application/pdf') {
          content.push({
            type: 'document',
            attachment: internalBlock.attachment,
            ...(internalBlock.name ? { name: internalBlock.name } : {}),
          });
        } else {
          throw new DelegatedUserTurnError('Cannot materialize delegated user turn: unsupported stored media type');
        }
      } else if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        content.push(await materializeImageBlock(input.conversationId, block, conversation.workspacePath, input.signal));
      } else if (block.type === 'document') {
        content.push(await materializeDocumentBlock(input.conversationId, block, input.signal));
      } else {
        throw new DelegatedUserTurnError('Cannot materialize delegated user turn: unsupported content block');
      }
      throwIfAborted(input.signal);
    }
  }

  if (content.length === 0) {
    throw new DelegatedUserTurnError('Cannot materialize delegated user turn: source content is empty');
  }

  return deepFreeze({
    schemaVersion: DELEGATED_USER_TURN_SCHEMA_VERSION,
    origin: {
      conversationId: input.conversationId,
      loopId: input.loopId,
      messageId: sourceMessage.id,
    },
    content,
  });
}

export function hasDelegatedTurnMedia(turn: DelegatedUserTurn | undefined): boolean {
  return !!turn?.content.some((block) => block.type === 'image' || block.type === 'document');
}

async function refToMessageContent(
  originConversationId: string,
  ref: MediaRef,
  signal?: AbortSignal,
  name?: string,
): Promise<ImageContent | DocumentContent> {
  throwIfAborted(signal);
  const bytes = await readDelegatedMedia(originConversationId, ref, signal);
  if (!bytes) {
    throw new DelegatedUserTurnError('Cannot prepare delegated user turn: stored media is missing or corrupt');
  }
  const data = uint8ArrayToBase64(bytes);
  if (ref.mediaType.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: ref.mediaType as ImageContent['source']['media_type'],
        data,
      },
    };
  }
  if (ref.mediaType === 'application/pdf') {
    return {
      type: 'document',
      ...(name ? { name } : {}),
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data,
      },
    };
  }
  throw new DelegatedUserTurnError('Cannot prepare delegated user turn: unsupported stored media type');
}

function mediaRefIdentity(originConversationId: string, ref: MediaRef): string {
  return `${originConversationId}:${ref.id}`;
}

function mediaRefMetadata(ref: MediaRef): string {
  return [
    ref.sha256,
    ref.mediaType,
    ref.bytes,
    ref.width ?? '',
    ref.height ?? '',
  ].join(':');
}

type DelegatedRefContent = Readonly<{
  type: 'delegated_media_ref';
  originConversationId: string;
  attachment: MediaRef;
  name?: string;
}>;

type InternalSubagentContent = MessageContent | DelegatedRefContent;

function refToInternalContent(originConversationId: string, ref: MediaRef, name?: string): DelegatedRefContent {
  return {
    type: 'delegated_media_ref',
    originConversationId,
    attachment: ref,
    ...(name ? { name } : {}),
  };
}

async function inlineMediaToDelegatedRef(
  conversationId: string,
  block: ImageContent | DocumentContent,
  signal: AbortSignal | undefined,
): Promise<DelegatedRefContent> {
  const kind = block.type === 'image' ? 'image' : 'document';
  const mediaType = block.source.media_type;
  if (block.type === 'document' && block.originConversationId !== undefined && block.originConversationId !== conversationId) {
    throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin mismatch');
  }
  const bytes = decodeInlineBytes(block.source.data, kind);
  const attachment = await raceAbort(
    persistDelegatedMediaAbortable(conversationId, { mediaType, bytes }, signal),
    signal,
  );
  return refToInternalContent(conversationId, attachment, block.type === 'document' ? block.name : undefined);
}

function stripImageFilePath(block: ImageContent): ImageContent {
  const { filePath: _filePath, ...rest } = block;
  return rest;
}

function isSafeOutputRefRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function redactAbsoluteMediaPaths(value: string): string {
  return redactSensitiveMediaText(value);
}

async function prepareMessageContentForSidecarWire(
  conversationId: string,
  content: string | readonly MessageContent[],
  signal: AbortSignal | undefined,
): Promise<{ content: string | InternalSubagentContent[]; changed: boolean }> {
  if (typeof content === 'string') return { content, changed: false };
  const prepared: InternalSubagentContent[] = [];
  let changed = false;
  for (const block of content) {
    throwIfAborted(signal);
    const internalBlock: unknown = block;
    if (isDelegatedRefContent(internalBlock)) {
      if (internalBlock.originConversationId !== conversationId) {
        throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin mismatch');
      }
      prepared.push(internalBlock);
    } else if (block.type === 'image' && block.source.data) {
      prepared.push(await inlineMediaToDelegatedRef(conversationId, block, signal));
      changed = true;
    } else if (block.type === 'image' && block.filePath) {
      prepared.push(stripImageFilePath(block));
      changed = true;
    } else if (block.type === 'document' && block.originConversationId !== undefined && block.originConversationId !== conversationId) {
      throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin mismatch');
    } else if (block.type === 'document' && block.source.data) {
      prepared.push(await inlineMediaToDelegatedRef(conversationId, block, signal));
      changed = true;
    } else {
      prepared.push(block);
    }
  }
  return { content: prepared, changed };
}

async function prepareToolResultContentForSidecarWire(
  conversationId: string,
  resultContent: readonly ToolResultContent[] | undefined,
  signal: AbortSignal | undefined,
): Promise<{ resultContent?: ToolResultContent[]; changed: boolean }> {
  if (!resultContent) return { resultContent: undefined, changed: false };
  let changed = false;
  const prepared: ToolResultContent[] = [];
  for (const block of resultContent) {
    throwIfAborted(signal);
    const internalBlock: unknown = block;
    if (isDelegatedRefContent(internalBlock)) {
      if (internalBlock.originConversationId !== conversationId) {
        throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin mismatch');
      }
      prepared.push(internalBlock as unknown as ToolResultContent);
    } else if (
      block.type === 'image'
      && block.source.data
      && isSafeOutputRefRelPath(block.outputRef?.relPath)
    ) {
      prepared.push({
        ...block,
        source: { ...block.source, data: '' },
        outputRef: { ...block.outputRef },
      });
      changed = true;
    } else if (block.type === 'image' && block.source.data) {
      prepared.push(await inlineMediaToDelegatedRef(conversationId, block as ImageContent, signal) as unknown as ToolResultContent);
      changed = true;
    } else if (block.type === 'image' && block.outputRef?.relPath && !isSafeOutputRefRelPath(block.outputRef.relPath)) {
      throw new DelegatedUserTurnError('Cannot prepare sidecar tool image: unsafe output ref');
    } else {
      prepared.push(block);
    }
  }
  return { resultContent: prepared, changed };
}

/** Shell → sidecar tool-result boundary for image-bearing rich results. */
export async function prepareToolResultForSidecarWire(
  conversationId: string | undefined,
  result: ToolResult,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (typeof result === 'string') return result;
  const hasImage = result.some((block) => block.type === 'image');
  if (!hasImage) return result;
  if (!conversationId) {
    throw new DelegatedUserTurnError('Cannot prepare sidecar tool media: media origin is missing');
  }
  const pathSafeResult = result.map((block): ToolResultContent => (
    block.type === 'text'
      ? { ...block, text: redactAbsoluteMediaPaths(block.text) }
      : {
          type: 'image',
          source: { ...block.source },
        }
  ));
  const prepared = await prepareToolResultContentForSidecarWire(conversationId, pathSafeResult, signal);
  return prepared.resultContent ?? [];
}

function hasRawMediaBase64Source(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const type = (entry as { type?: unknown }).type;
  if (type !== 'image' && type !== 'document') return false;
  return typeof (entry as { source?: { data?: unknown } }).source?.data === 'string'
    && Boolean((entry as { source: { data: string } }).source.data);
}

function hasRawDetailImageDataBase64(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return typeof (entry as { mediaType?: unknown }).mediaType === 'string'
    && typeof (entry as { base64?: unknown }).base64 === 'string'
    && Boolean((entry as { base64: string }).base64);
}

function isWireDetailImageDataRef(entry: unknown): entry is {
  mediaType: string;
  outputRef?: unknown;
  delegatedMediaRef: DelegatedRefContent;
} {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as { mediaType?: unknown; delegatedMediaRef?: unknown };
  return typeof record.mediaType === 'string' && isDelegatedRefContent(record.delegatedMediaRef);
}

function hasRawDetailBlockImageData(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return hasRawDetailImageDataBase64((entry as { imageData?: unknown }).imageData);
}

export function sidecarValueNeedsMediaEncoding(value: unknown): boolean {
  let found = false;
  const visit = (entry: unknown): void => {
    if (found || isDelegatedRefContent(entry)) return;
    if (hasRawMediaBase64Source(entry) || hasRawDetailImageDataBase64(entry)) {
      found = true;
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const child of Object.values(entry as Record<string, unknown>)) visit(child);
  };
  visit(value);
  return found;
}

export function redactSidecarValueForWireFailure<T>(value: T): T {
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redactAbsoluteMediaPaths(entry);
    if (Array.isArray(entry)) return entry.map((child) => visit(child));
    if (!entry || typeof entry !== 'object') return entry;
    if (hasRawMediaBase64Source(entry)) {
      const record = entry as { source: Record<string, unknown> };
      return { ...record, source: { ...record.source, data: '' } };
    }
    if (hasRawDetailBlockImageData(entry)) {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        if (key === 'imageData') continue;
        output[key] = visit(child);
      }
      return {
        ...output,
        type: 'error',
        content: 'Error: Could not prepare sidecar media for transport.',
      };
    }
    if (hasRawDetailImageDataBase64(entry)) {
      const record = entry as { mediaType: string; outputRef?: unknown };
      return {
        mediaType: record.mediaType,
        transportError: 'Error: Could not prepare sidecar media for transport.',
        ...(record.outputRef === undefined ? {} : { outputRef: record.outputRef }),
      };
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      output[key] = visit(child);
    }
    return output;
  };
  return visit(value) as T;
}

export async function prepareSidecarValueForWire<T>(
  conversationId: string | undefined,
  value: T,
  signal?: AbortSignal,
): Promise<T> {
  const visit = async (entry: unknown): Promise<unknown> => {
    throwIfAborted(signal);
    if (typeof entry === 'string') return redactAbsoluteMediaPaths(entry);
    if (isDelegatedRefContent(entry)) return entry;
    if (hasRawDetailImageDataBase64(entry)) {
      if (!conversationId) {
        throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin is missing');
      }
      const imageData = entry as { mediaType: string; base64: string; outputRef?: unknown };
      const ref = await inlineMediaToDelegatedRef(conversationId, {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageData.mediaType as ImageContent['source']['media_type'],
          data: imageData.base64,
        },
      }, signal);
      return {
        mediaType: imageData.mediaType,
        delegatedMediaRef: ref,
        ...(imageData.outputRef === undefined ? {} : { outputRef: imageData.outputRef }),
      };
    }
    if (hasRawMediaBase64Source(entry)) {
      if (!conversationId) {
        throw new DelegatedUserTurnError('Cannot prepare sidecar media: media origin is missing');
      }
      return inlineMediaToDelegatedRef(
        conversationId,
        entry as ImageContent | DocumentContent,
        signal,
      );
    }
    if (Array.isArray(entry)) return Promise.all(entry.map((child) => visit(child)));
    if (entry && typeof entry === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        output[key] = await visit(child);
      }
      return output;
    }
    return entry;
  };
  return await visit(value) as T;
}

/** Sidecar → shell display boundary; refs become renderable only after NDJSON. */
export async function materializeSidecarMediaRefsForShell<T>(
  value: T,
  expectedOriginConversationId: string,
  signal?: AbortSignal,
): Promise<T> {
  const seenMediaRefs = new Map<string, string>();
  const visit = async (entry: unknown): Promise<unknown> => {
    throwIfAborted(signal);
    if (isWireDetailImageDataRef(entry)) {
      assertNoDelegatedMediaMetadataConflicts(
        [entry.delegatedMediaRef],
        seenMediaRefs,
        expectedOriginConversationId,
      );
      const content = await raceAbort(
        refToMessageContent(
          entry.delegatedMediaRef.originConversationId,
          entry.delegatedMediaRef.attachment,
          signal,
          entry.delegatedMediaRef.name,
        ),
        signal,
      );
      if (content.type !== 'image') {
        throw new DelegatedUserTurnError('Cannot materialize sidecar media: detail image ref is not an image');
      }
      return {
        mediaType: content.source.media_type,
        base64: content.source.data,
        ...(entry.outputRef === undefined ? {} : { outputRef: entry.outputRef }),
      };
    }
    if (isDelegatedRefContent(entry)) {
      assertNoDelegatedMediaMetadataConflicts(
        [entry],
        seenMediaRefs,
        expectedOriginConversationId,
      );
      return raceAbort(
        refToMessageContent(entry.originConversationId, entry.attachment, signal, entry.name),
        signal,
      );
    }
    if (hasRawMediaBase64Source(entry)) {
      throw new DelegatedUserTurnError('Cannot materialize sidecar media: raw base64 crossed the wire');
    }
    if (hasRawDetailImageDataBase64(entry)) {
      throw new DelegatedUserTurnError('Cannot materialize sidecar media: raw image data crossed the wire');
    }
    if (Array.isArray(entry)) return Promise.all(entry.map((child) => visit(child)));
    if (entry && typeof entry === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        output[key] = await visit(child);
      }
      return output;
    }
    return entry;
  };
  return await visit(value) as T;
}

/** Fast wire inspection used to keep media-free frame/progress paths synchronous. */
export function sidecarValueHasOpaqueMediaRefs(value: unknown): boolean {
  let found = false;
  const visit = (entry: unknown): void => {
    if (isDelegatedRefContent(entry)) {
      found = true;
      return;
    }
    if (isWireDetailImageDataRef(entry)) {
      found = true;
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    if (hasRawDetailImageDataBase64(entry)) {
      throw new DelegatedUserTurnError('Cannot inspect sidecar media: raw image data crossed the wire');
    }
    if (hasRawMediaBase64Source(entry)) {
      throw new DelegatedUserTurnError('Cannot inspect sidecar media: raw base64 crossed the wire');
    }
    for (const child of Object.values(entry as Record<string, unknown>)) visit(child);
  };
  visit(value);
  return found;
}

async function prepareToolCallsForSidecarWire<T extends ToolCall | ToolCallForContext>(
  conversationId: string,
  calls: readonly T[] | undefined,
  signal: AbortSignal | undefined,
): Promise<{ calls?: T[]; changed: boolean }> {
  if (!calls) return { calls: undefined, changed: false };
  let changed = false;
  const prepared = await Promise.all(calls.map(async (call): Promise<T> => {
    const result = await prepareToolResultContentForSidecarWire(conversationId, call.resultContent, signal);
    if (!result.changed) return call;
    changed = true;
    return {
      ...call,
      resultContent: result.resultContent,
    } as T;
  }));
  return { calls: prepared, changed };
}

/**
 * Prepare the frozen main-loop conversation snapshot for sidecar transport.
 *
 * The renderer-facing transcript may contain inline image/PDF base64 so local
 * history and in-process fallback keep their existing behavior. The sidecar
 * wire contract is stricter: media crosses as opaque delegated refs plus
 * metadata, then provider adapters materialize bytes at request time through
 * `prepareDelegatedUserTurnForRequest`.
 */
export async function prepareConversationSnapshotForSidecarWire(
  conversation: Conversation,
  signal?: AbortSignal,
): Promise<Conversation> {
  let changed = false;
  const messages: Message[] = [];
  for (const message of conversation.messages) {
    const prepared = await prepareMessageContentForSidecarWire(conversation.id, message.content, signal);
    const toolCalls = await prepareToolCallsForSidecarWire(conversation.id, message.toolCalls, signal);
    const toolCallsForContext = await prepareToolCallsForSidecarWire(conversation.id, message.toolCallsForContext, signal);
    changed ||= prepared.changed;
    changed ||= toolCalls.changed || toolCallsForContext.changed;
    messages.push(prepared.changed || toolCalls.changed || toolCallsForContext.changed ? {
      ...message,
      content: prepared.content as Message['content'],
      ...(toolCalls.changed ? { toolCalls: toolCalls.calls as ToolCall[] } : {}),
      ...(toolCallsForContext.changed ? { toolCallsForContext: toolCallsForContext.calls as ToolCallForContext[] } : {}),
    } : message);
  }
  return changed ? { ...conversation, messages } : conversation;
}

function isDelegatedRefContent(value: unknown): value is DelegatedRefContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ['type', 'originConversationId', 'attachment', 'name'].includes(key))
    && record.type === 'delegated_media_ref'
    && isOpaqueMediaId(record.originConversationId)
    && isStrictMediaRef(record.attachment)
    && (record.name === undefined || typeof record.name === 'string');
}

function assertNoDelegatedMediaMetadataConflicts(
  content: readonly InternalSubagentContent[],
  seenMediaRefs: Map<string, string>,
  expectedOriginConversationId: string | undefined,
): void {
  for (const block of content) {
    if (!isDelegatedRefContent(block)) continue;
    if (!expectedOriginConversationId || block.originConversationId !== expectedOriginConversationId) {
      throw new DelegatedUserTurnError('Cannot prepare delegated user turn: media origin mismatch');
    }
    const identity = mediaRefIdentity(block.originConversationId, block.attachment);
    const metadata = mediaRefMetadata(block.attachment);
    const previousMetadata = seenMediaRefs.get(identity);
    if (previousMetadata !== undefined && previousMetadata !== metadata) {
      throw new DelegatedUserTurnError('Cannot prepare delegated user turn: stored media metadata conflict');
    }
    seenMediaRefs.set(identity, metadata);
  }
}

export async function buildInitialSubagentUserContent(
  input: BuildInitialContentInput,
): Promise<string | MessageContent[]> {
  const taskText = taskWithContext(input.task, input.context);
  if (input.delegatedUserTurn === undefined) {
    return taskText;
  }
  if (!isDelegatedUserTurn(input.delegatedUserTurn)) {
    throw new DelegatedUserTurnError('Cannot prepare delegated user turn: invalid envelope');
  }
  if (!hasDelegatedTurnMedia(input.delegatedUserTurn)) {
    return taskText;
  }

  const content: InternalSubagentContent[] = [];
  for (const block of input.delegatedUserTurn.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && input.imageDisposition === 'text-only') {
      content.push({ type: 'text', text: DELEGATED_TEXT_ONLY_IMAGE_PLACEHOLDER });
    } else if (block.type === 'image' || block.type === 'document') {
      content.push(refToInternalContent(
        input.delegatedUserTurn.origin.conversationId,
        block.attachment,
        block.type === 'document' ? block.name : undefined,
      ));
    }
  }
  content.push({ type: 'text', text: taskText });
  return content as MessageContent[];
}

export async function prepareDelegatedUserTurnForRequest(
  messages: readonly Message[],
  signal: AbortSignal | undefined,
  expectedOriginConversationId: string | undefined,
): Promise<Message[]> {
  throwIfAborted(signal);
  const prepared: Message[] = [];
  const seenMediaRefs = new Map<string, string>();
  for (const message of messages) {
    let changed = false;
    let content: Message['content'] = message.content;
    if (Array.isArray(message.content)) {
      const internalContent = message.content as InternalSubagentContent[];
      assertNoDelegatedMediaMetadataConflicts(internalContent, seenMediaRefs, expectedOriginConversationId);
      const materializedContent: MessageContent[] = [];
      for (const block of internalContent) {
        throwIfAborted(signal);
        if (isDelegatedRefContent(block)) {
          changed = true;
          materializedContent.push(await raceAbort(
            refToMessageContent(block.originConversationId, block.attachment, signal, block.name),
            signal,
          ) as MessageContent);
          throwIfAborted(signal);
        } else {
          materializedContent.push(block);
        }
      }
      content = materializedContent;
    }
    const toolCalls = await materializeToolCallsForRequest(
      message.toolCalls,
      signal,
      seenMediaRefs,
      expectedOriginConversationId,
    );
    const toolCallsForContext = await materializeToolCallsForRequest(
      message.toolCallsForContext,
      signal,
      seenMediaRefs,
      expectedOriginConversationId,
    );
    changed ||= toolCalls.changed || toolCallsForContext.changed;
    prepared.push(changed ? {
      ...message,
      content,
      ...(toolCalls.changed ? { toolCalls: toolCalls.calls as ToolCall[] } : {}),
      ...(toolCallsForContext.changed ? { toolCallsForContext: toolCallsForContext.calls as ToolCallForContext[] } : {}),
    } : message);
  }
  return prepared;
}

async function materializeToolResultContentForRequest(
  resultContent: readonly ToolResultContent[] | undefined,
  signal: AbortSignal | undefined,
  seenMediaRefs: Map<string, string>,
  expectedOriginConversationId: string | undefined,
): Promise<{ resultContent?: ToolResultContent[]; changed: boolean }> {
  if (!resultContent) return { resultContent: undefined, changed: false };
  assertNoDelegatedMediaMetadataConflicts(
    resultContent as InternalSubagentContent[],
    seenMediaRefs,
    expectedOriginConversationId,
  );
  let changed = false;
  const prepared: ToolResultContent[] = [];
  for (const block of resultContent) {
    throwIfAborted(signal);
    const maybeRef: unknown = block;
    if (!isDelegatedRefContent(maybeRef)) {
      prepared.push(block);
      continue;
    }
    changed = true;
    if (!maybeRef.attachment.mediaType.startsWith('image/')) {
      throw new DelegatedUserTurnError('Cannot prepare delegated tool result: unsupported stored media type');
    }
    prepared.push(await raceAbort(
      refToMessageContent(maybeRef.originConversationId, maybeRef.attachment, signal),
      signal,
    ) as ToolResultContent);
  }
  return { resultContent: prepared, changed };
}

async function materializeToolCallsForRequest<T extends ToolCall | ToolCallForContext>(
  calls: readonly T[] | undefined,
  signal: AbortSignal | undefined,
  seenMediaRefs: Map<string, string>,
  expectedOriginConversationId: string | undefined,
): Promise<{ calls?: T[]; changed: boolean }> {
  if (!calls) return { calls: undefined, changed: false };
  let changed = false;
  const prepared = await Promise.all(calls.map(async (call): Promise<T> => {
    const result = await materializeToolResultContentForRequest(
      call.resultContent,
      signal,
      seenMediaRefs,
      expectedOriginConversationId,
    );
    if (!result.changed) return call;
    changed = true;
    return { ...call, resultContent: result.resultContent } as T;
  }));
  return { calls: prepared, changed };
}
