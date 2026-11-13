/**
 * Per-image admission at the request boundary: may this picture go to this
 * route at all?
 *
 * Every picture in a request reaches the provider from one of many places — a
 * user attachment, read_file, a screenshot, an MCP tool, a sub-agent — and
 * each place fits its pictures by its own rule, or by none (read_file resizes
 * by FILE SIZE, so a wide PNG of 1.7 MB went out whole and DeepSeek answered
 * 400 "unsupported image", which ended the run). The request body is the one
 * place they all pass, so the rule a provider enforces is enforced here, by
 * the route's own numbers (`resolveImagePolicy`):
 *
 * - a picture whose header says it is larger than the route takes on a side is
 *   left out;
 * - a picture in a format no route takes (BMP, SVG, TIFF, …) is left out;
 * - a picture labelled with the wrong one of the four formats every route takes
 *   (a JPEG named .png) is sent under the format its bytes are in;
 * - data that is no picture at all (a PDF, a ZIP archive such as an Office
 *   file, text) is left out: a record that held a PDF under an image label
 *   went out as image/jpeg and the provider refused every later request of
 *   the conversation.
 *
 * A left-out picture is replaced by a note that says what it was and how to
 * look at it, never dropped silently. Pictures are judged by their header
 * only, so this costs a few bytes of base64 decoding per picture; data whose
 * header is in no format this knows and that could still be a picture is
 * sent under its label (the provider decides), so nothing is lost on a guess;
 * data that is not Base64 at all cannot be decoded by any provider and is left
 * out with the same kind of note.
 *
 * The verdict is a pure function of the bytes and the route, so a replayed
 * history builds the same request body (prompt cache, deterministic replays).
 * LLM-facing text → English.
 */

import { base64ImageHeaderSize } from '../../utils/imageHeaderSize';
import { sniffImageMediaType, SUPPORTED_IMAGE_TYPES } from '../../utils/imageUtils';

export type ImageVerdict =
  | { kind: 'send'; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  /**
   * Left out for its size (`size` is its pixel size, `bytes` its base64 length), for its format (`format`, e.g. "BMP"),
   * or as no picture (`notPicture` says what it holds, e.g. "a PDF document").
   */
  | { kind: 'leave-out'; note: string; size?: { w: number; h: number }; bytes?: number; format?: string; notPicture?: string };

const SENDABLE: ReadonlySet<string> = new Set(SUPPORTED_IMAGE_TYPES);

/** Base64 characters that hold the 18 bytes the checks below read (`sniffImageMediaType` reads 16). */
const SNIFF_CHARS = 24;

/** What the note says about data that cannot be decoded as Base64 (distinct from data that decodes to a header in no known format). */
const NOT_BASE64 = 'data that is not valid Base64';

/** The first bytes of a picture's data, or null when the data is not base64. */
function head(data: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(data.slice(0, SNIFF_CHARS)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
}

const FTYP = [0x66, 0x74, 0x79, 0x70];
const HEIF_BRANDS: Readonly<Record<string, string>> = {
  heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic', hevx: 'image/heic',
  mif1: 'image/heif', msf1: 'image/heif', avif: 'image/avif', avis: 'image/avif',
};

/** The format of a picture, also one no route takes: the four, BMP, TIFF, HEIC/HEIF and AVIF. */
function sniff(bytes: Uint8Array): string | null {
  const known = sniffImageMediaType(bytes);
  if (known) return known;
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (startsWith(bytes, FTYP, 4)) return HEIF_BRANDS[String.fromCharCode(...bytes.subarray(8, 12))] ?? null;
  return null;
}

/** Leading bytes of data that is a document or an archive, never a picture. */
const NOT_PICTURES: ReadonlyArray<{ signature: readonly number[]; what: string }> = [
  { signature: [0x25, 0x50, 0x44, 0x46], what: 'a PDF document' },
  { signature: [0x50, 0x4b, 0x03, 0x04], what: 'a ZIP archive, such as a Word, Excel or PowerPoint file' },
  { signature: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], what: 'an old-format Office document' },
];

/** Printable text, UTF-8 included: no control byte but tab and line breaks. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.some((b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f)) return false;
  try {
    // `stream` lets the last character be cut off where the head ends.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Fewer leading bytes than this say nothing about being text. */
const MIN_TEXT_BYTES = 8;

/** What data in no picture format is, when it clearly is no picture; null when it could still be one. */
function notAPicture(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'no data';
  const known = NOT_PICTURES.find((entry) => startsWith(bytes, entry.signature));
  if (known) return known.what;
  return bytes.length >= MIN_TEXT_BYTES && isText(bytes) ? 'text' : null;
}

/** "BMP" for image/bmp, "SVG" for image/svg+xml. */
export function formatName(mediaType: string): string {
  const subtype = mediaType.replace(/^image\//i, '').replace(/\+xml$/i, '').replace(/^x-/i, '');
  return subtype ? subtype.toUpperCase() : 'an unknown';
}

const HOW_TO_LOOK = 'If it is a picture file, save a smaller PNG or JPEG copy (for example with a script) and read that.';

export function oversizeNote(width: number, height: number, maxDimension: number): string {
  return `[A picture of ${width}×${height} px was left out of this request: this model takes pictures of at most ${maxDimension} px on a side. ${HOW_TO_LOOK}]`;
}

export function oversizeBytesNote(bytes: number, maxBytes: number): string {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `[A picture of ${mb(bytes)} was left out of this request: this model takes pictures of at most ${mb(maxBytes)}. ${HOW_TO_LOOK}]`;
}

export function notPictureNote(what: string): string {
  return `[A picture was left out of this request: what it holds is not a picture (${what}). `
    + 'If it came from a file, read that file to see what it holds.]';
}

export function formatNote(mediaType: string): string {
  return `[A picture in ${formatName(mediaType)} format was left out of this request: this model takes PNG, JPEG, GIF and WebP pictures only. `
    + 'Save it as PNG (for example with a script) and read that.]';
}

/**
 * Whether one picture may go to a route that REJECTS pictures above `maxDimension` px on a
 * side or `maxBytes` base64 characters (both are the route's hard limits, `imageAcceptanceLimits`,
 * not the smaller size pictures are fitted to at entry), and under which media type.
 */
export function judgeImage(declaredMediaType: string, data: string, maxDimension: number, maxBytes?: number): ImageVerdict {
  const bytes = head(data);
  // Not base64 at all: no provider decodes it, so it would fail every later request of the conversation.
  if (bytes === null) return { kind: 'leave-out', note: notPictureNote(NOT_BASE64), notPicture: NOT_BASE64 };
  const sniffed = sniff(bytes);
  if (sniffed !== null && !SENDABLE.has(sniffed)) {
    return { kind: 'leave-out', note: formatNote(sniffed), format: formatName(sniffed) };
  }
  // Unrecognised bytes: only the label can be judged.
  const mediaType = sniffed ?? declaredMediaType.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!SENDABLE.has(mediaType)) {
    return { kind: 'leave-out', note: formatNote(declaredMediaType), format: formatName(declaredMediaType) };
  }
  // A sendable label on bytes in no picture format: sent only while they could still be a picture.
  const notPicture = sniffed === null ? notAPicture(bytes) : null;
  if (notPicture) return { kind: 'leave-out', note: notPictureNote(notPicture), notPicture };
  const size = sniffed !== null && Number.isFinite(maxDimension) && maxDimension > 0 ? base64ImageHeaderSize(data) : null;
  if (size && Math.max(size.w, size.h) > maxDimension) {
    return { kind: 'leave-out', note: oversizeNote(size.w, size.h, maxDimension), size };
  }
  if (maxBytes !== undefined && Number.isFinite(maxBytes) && data.length > maxBytes) {
    return { kind: 'leave-out', note: oversizeBytesNote(data.length, maxBytes), bytes: data.length };
  }
  return { kind: 'send', mediaType: mediaType as Extract<ImageVerdict, { kind: 'send' }>['mediaType'] };
}
