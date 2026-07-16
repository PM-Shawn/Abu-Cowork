/**
 * Client-side screenshot compression for diagnostic feedback attachments.
 *
 * Pure browser API usage (canvas + createImageBitmap) — no Node APIs. Only
 * kicks in when the source is already larger than `maxBytes`; small
 * screenshots are returned untouched. Re-encodes as JPEG since that's what
 * gives the best size/quality tradeoff for screenshots pasted from the OS
 * clipboard or picked via file dialog.
 *
 * Not unit-tested: happy-dom (the Vitest environment for this repo) has no
 * canvas/`toBlob` implementation, so exercising this file requires a real
 * browser. Logic is kept small and linear so it's reviewable by inspection;
 * any failure (unsupported API, decode error) falls back to returning the
 * original bytes rather than throwing, so a compression bug can never block
 * the user from attaching a screenshot.
 */

export interface CompressImageInput {
  bytes: Uint8Array;
  mediaType: string;
}

export interface CompressImageOptions {
  /** Longest edge, in px, to downscale to (aspect ratio preserved, never upscaled). */
  maxEdge?: number;
  /** Only compress when the source exceeds this size, in bytes. */
  maxBytes?: number;
  /** JPEG re-encode quality, 0–1. */
  quality?: number;
}

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_QUALITY = 0.85;

/**
 * Downscale + re-encode an image as JPEG when it exceeds `maxBytes`.
 * Returns the original input untouched (same reference) when no compression
 * is needed or when the browser APIs required to compress are unavailable.
 */
export async function compressImage(
  input: CompressImageInput,
  opts: CompressImageOptions = {},
): Promise<CompressImageInput> {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const quality = opts.quality ?? DEFAULT_QUALITY;

  if (input.bytes.length <= maxBytes) {
    return input;
  }

  try {
    // `input.bytes` is already a Uint8Array — no need to copy it into a new
    // one just to hand it to Blob. The `as` narrows TS's generic
    // `Uint8Array<ArrayBufferLike>` to the `Uint8Array<ArrayBuffer>` that
    // `BlobPart` requires; it's a type-only cast (no runtime copy) — safe
    // here because these bytes always come from a plain (non-shared)
    // ArrayBuffer source (file reads / canvas encode), never SharedArrayBuffer.
    const blob = new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mediaType });
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
      const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return input;

      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

      const outBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
      });
      if (!outBlob) return input;

      const buf = await outBlob.arrayBuffer();
      return { bytes: new Uint8Array(buf), mediaType: 'image/jpeg' };
    } finally {
      bitmap.close();
    }
  } catch {
    // Decode/encode failed for any reason (corrupt image, no canvas support,
    // etc.) — never block the user's screenshot attach on a compression bug.
    return input;
  }
}
