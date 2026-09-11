interface ImageMediaTypeDefinition {
  canonicalExtension: string;
  canonicalMimeType: string;
  extensionAliases?: readonly string[];
  mimeTypeAliases?: readonly string[];
}

/** Single source of truth for supported image extensions and MIME aliases. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaTypeDefinition[] = [
  { canonicalExtension: 'png', canonicalMimeType: 'image/png' },
  {
    canonicalExtension: 'jpg',
    canonicalMimeType: 'image/jpeg',
    extensionAliases: ['jpeg'],
    mimeTypeAliases: ['image/jpg'],
  },
  { canonicalExtension: 'webp', canonicalMimeType: 'image/webp' },
  { canonicalExtension: 'gif', canonicalMimeType: 'image/gif' },
  { canonicalExtension: 'bmp', canonicalMimeType: 'image/bmp' },
  { canonicalExtension: 'svg', canonicalMimeType: 'image/svg+xml' },
  {
    canonicalExtension: 'ico',
    canonicalMimeType: 'image/x-icon',
    mimeTypeAliases: ['image/vnd.microsoft.icon'],
  },
];

/** Image file extension (including aliases) to canonical MIME type. */
export const IMAGE_MIME_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  IMAGE_MEDIA_TYPES.flatMap(({ canonicalExtension, canonicalMimeType, extensionAliases = [] }) => [
    [canonicalExtension, canonicalMimeType] as const,
    ...extensionAliases.map((extension) => [extension, canonicalMimeType] as const),
  ]),
);

/** Image MIME type (including aliases) to canonical on-disk extension. */
export const RESULT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  IMAGE_MEDIA_TYPES.flatMap(({ canonicalExtension, canonicalMimeType, mimeTypeAliases = [] }) => [
    [canonicalMimeType, canonicalExtension] as const,
    ...mimeTypeAliases.map((mimeType) => [mimeType, canonicalExtension] as const),
  ]),
);
