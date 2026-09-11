import type { ModelCapabilities } from '../llm/modelCapabilities';
import type { AdapterKind } from '../llm/adapter';
import { resolveImagePolicy } from '../llm/imagePolicy';
import { isDelegatedUserTurn } from './delegatedUserTurn';

/** Conservative cross-provider ceiling. Route-specific variants belong to batch two. */
export const MAX_DELEGATED_IMAGE_COUNT = 20;
/** Base64 payload limit per image (not decoded bytes). */
export const MAX_DELEGATED_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

export type DelegatedMediaFailureReason =
  | 'vision_unsupported'
  | 'document_unsupported'
  | 'image_count'
  | 'image_payload_too_large'
  | 'image_total_too_large'
  | 'invalid_turn';

/** Deliberately allowlisted diagnostic data: safe for logs and runtime traces. */
export interface DelegatedMediaDiagnostic {
  readonly outcome: 'not_sent' | 'text_only';
  readonly reason: DelegatedMediaFailureReason;
  readonly imageCount: number;
  readonly documentCount: number;
}

export type DelegatedMediaPreflight =
  | { readonly kind: 'send'; readonly imageDisposition: 'send' }
  | { readonly kind: 'send'; readonly imageDisposition: 'text-only'; readonly diagnostic: DelegatedMediaDiagnostic }
  | { readonly kind: 'error'; readonly diagnostic: DelegatedMediaDiagnostic };

/** Base64 character count for a raw byte length. This is intentionally the same
 * unit `imageBudget`/`resolveImagePolicy` use for outbound request payloads. */
export function base64PayloadLength(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}


function diagnostic(
  reason: DelegatedMediaFailureReason,
  imageCount: number,
  documentCount: number,
  outcome: DelegatedMediaDiagnostic['outcome'] = 'not_sent',
): DelegatedMediaPreflight {
  return { kind: 'error', diagnostic: { outcome, reason, imageCount, documentCount } };
}

/**
 * Metadata-only delegated-media admission. It MUST run before attachment bytes
 * are read or an adapter request is created. No fallback silently deletes media.
 */
export function preflightDelegatedMedia(
  turn: unknown,
  caps: Pick<ModelCapabilities, 'vision' | 'documentBlock'>,
  modelId: string,
  adapterKind: AdapterKind = 'claude',
  fallback?: 'text-only',
): DelegatedMediaPreflight {
  if (turn === undefined) return { kind: 'send', imageDisposition: 'send' };
  if (!isDelegatedUserTurn(turn)) return diagnostic('invalid_turn', 0, 0);
  const images = turn.content.filter((block) => block.type === 'image');
  const documents = turn.content.filter((block) => block.type === 'document');
  const documentCount = documents.length;
  const imageCount = images.length;

  if (documentCount > 0 && (!caps.documentBlock || adapterKind !== 'claude')) {
    return diagnostic('document_unsupported', imageCount, documentCount);
  }
  if (imageCount > 0 && !caps.vision) {
    if (fallback === 'text-only') {
      return { kind: 'send', imageDisposition: 'text-only', diagnostic: {
        outcome: 'text_only', reason: 'vision_unsupported', imageCount, documentCount,
      } };
    }
    return diagnostic('vision_unsupported', imageCount, documentCount);
  }
  if (imageCount > MAX_DELEGATED_IMAGE_COUNT) {
    return diagnostic('image_count', imageCount, documentCount);
  }
  const imagePayloads = images.map((block) => base64PayloadLength(block.attachment.bytes));
  if (imagePayloads.some((length) => length > MAX_DELEGATED_IMAGE_BASE64_BYTES)) {
    return diagnostic('image_payload_too_large', imageCount, documentCount);
  }
  if (imagePayloads.reduce((total, length) => total + length, 0) > resolveImagePolicy(modelId).maxRequestImageBytes) {
    return diagnostic('image_total_too_large', imageCount, documentCount);
  }
  return { kind: 'send', imageDisposition: 'send' };
}

/** Fixed model-visible fallback; never includes an attachment id, path, or bytes. */
export const DELEGATED_TEXT_ONLY_IMAGE_PLACEHOLDER =
  '[Attached image omitted because the selected subagent model does not support vision.]';
