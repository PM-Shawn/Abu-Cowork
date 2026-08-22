export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function generateAttachmentId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/** Bytes needed to recognise every signature below (WebP's marker ends at 12). */
export const IMAGE_MAGIC_PREFIX_BYTES = 16;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38]; // "GIF8" — covers 87a and 89a
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8
const BMP_SIGNATURE = [0x42, 0x4d]; // "BM"

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/**
 * Identify a supported image by its leading bytes.
 *
 * Names lie. When an app copies an image, macOS puts a pasteboard temp item on
 * the clipboard whose path carries no usable extension (`…/id=6571367.107158211`)
 * and which Chromium hands to the renderer as a `File` with an EMPTY `type`.
 * Extension- and mime-based routing both misfile that as a plain document, so
 * the picture is lost. The bytes are the only honest signal.
 *
 * Recognised types are the four the composer can send as-is
 * (`SUPPORTED_IMAGE_TYPES`) plus BMP, which the admission gate re-encodes to a
 * wire-safe format (`fitImageToDimension`) — the drag path already admits
 * `.bmp` by extension, so the paste path recognising the same bytes keeps the
 * two entrances consistent. Anything else stays a file attachment, which is
 * what it was before. Pass at least `IMAGE_MAGIC_PREFIX_BYTES` bytes.
 */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, GIF_SIGNATURE)) return 'image/gif';
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return 'image/webp';
  if (startsWith(bytes, BMP_SIGNATURE)) return 'image/bmp';
  return null;
}
