/**
 * Stable, transport-safe contract for the user turn that caused a subagent
 * delegation. This module deliberately contains no prompt assembly or entry
 * point logic: B2 owns materialisation and B3 owns transport validation.
 */

export const DELEGATED_USER_TURN_SCHEMA_VERSION = 1 as const;

export interface MediaRef {
  /** Opaque media-store identity. It is never a filesystem path or URL. */
  readonly id: string;
  /** Lowercase SHA-256 of the exact stored bytes. */
  readonly sha256: string;
  /** Canonical MIME type accepted by the delegated-media store. */
  readonly mediaType: string;
  /** Exact byte length of the stored payload. */
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
}

export type DelegatedContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: MediaRef; readonly detail?: 'auto' | 'low' | 'high' }
  | { readonly type: 'document'; readonly attachment: MediaRef; readonly name?: string };

export interface DelegatedUserTurn {
  readonly schemaVersion: typeof DELEGATED_USER_TURN_SCHEMA_VERSION;
  readonly origin: Readonly<{
    conversationId: string;
    loopId: string;
    messageId: string;
  }>;
  readonly content: readonly DelegatedContentBlock[];
}

/** Current composer-supported media. Additional formats require an explicit store migration. */
export const DELEGATED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

export type DelegatedMediaType = typeof DELEGATED_MEDIA_TYPES[number];

export function isDelegatedMediaType(value: unknown): value is DelegatedMediaType {
  return typeof value === 'string' && (DELEGATED_MEDIA_TYPES as readonly string[]).includes(value);
}

const OPAQUE_MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isOpaqueMediaId(value: unknown): value is string {
  return typeof value === 'string'
    && OPAQUE_MEDIA_ID.test(value)
    && !value.includes('..')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !value.startsWith('~');
}

/** Runtime guard shared by the store and the later sidecar boundary. */
export function isMediaRef(value: unknown): value is MediaRef {
  if (!isRecord(value)) return false;
  const ref = value as Record<string, unknown>;
  if (
    !isOpaqueMediaId(ref.id)
    || typeof ref.sha256 !== 'string' || !SHA256_HEX.test(ref.sha256)
    || !isDelegatedMediaType(ref.mediaType)
    || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) <= 0
  ) return false;
  return [ref.width, ref.height].every(
    (dimension) => dimension === undefined || (Number.isSafeInteger(dimension) && (dimension as number) > 0),
  );
}

export function isStrictMediaRef(value: unknown): value is MediaRef {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'sha256', 'mediaType', 'bytes', 'width', 'height'])
    && isMediaRef(value);
}

function isStrictDelegatedContentBlock(value: unknown): value is DelegatedContentBlock {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text':
      return hasOnlyKeys(value, ['type', 'text'])
        && typeof value.text === 'string';
    case 'image':
      return hasOnlyKeys(value, ['type', 'attachment', 'detail'])
        && isStrictMediaRef(value.attachment)
        && typeof (value.attachment as MediaRef).mediaType === 'string'
        && (value.attachment as MediaRef).mediaType.startsWith('image/')
        && (value.detail === undefined || value.detail === 'auto' || value.detail === 'low' || value.detail === 'high');
    case 'document':
      return hasOnlyKeys(value, ['type', 'attachment', 'name'])
        && isStrictMediaRef(value.attachment)
        && (value.attachment as MediaRef).mediaType === 'application/pdf'
        && (value.name === undefined || typeof value.name === 'string');
    default:
      return false;
  }
}

export function isDelegatedUserTurn(value: unknown): value is DelegatedUserTurn {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['schemaVersion', 'origin', 'content'])) return false;
  if (value.schemaVersion !== DELEGATED_USER_TURN_SCHEMA_VERSION) return false;
  if (!isRecord(value.origin) || !hasOnlyKeys(value.origin, ['conversationId', 'loopId', 'messageId'])) return false;
  if (
    !isOpaqueMediaId(value.origin.conversationId)
    || !isOpaqueMediaId(value.origin.loopId)
    || !isOpaqueMediaId(value.origin.messageId)
  ) return false;
  if (!Array.isArray(value.content) || value.content.length === 0) return false;
  return value.content.every(isStrictDelegatedContentBlock);
}
