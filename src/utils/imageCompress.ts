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

// ────────────────────────────────────────────────────────────────────
// Dimension fitting (composer admission)
// ────────────────────────────────────────────────────────────────────

/** Dimensions before and after a fit, for the model-visible resize notice. */
export interface ImageResizeRecord {
  fromWidth: number;
  fromHeight: number;
  toWidth: number;
  toHeight: number;
}

export interface FitImageResult {
  bytes: Uint8Array;
  mediaType: string;
  /** Present only when the image was actually scaled down. */
  resized?: ImageResizeRecord;
}

/** Canvas can only encode these; anything else is re-encoded as PNG so alpha survives. */
const ENCODABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The only media types a provider route accepts, and the only ones
 * `ImageAttachment.mediaType` can legally hold.
 *
 * Admission must normalise to this set, not just to a pixel bound. `.bmp` is a
 * live example: it is in the composer's IMAGE_EXTENSIONS and pathUtils maps it
 * to `image/bmp`, so a dropped bitmap arrives here fully legitimate-looking —
 * and a `data:image/bmp;base64,...` part is a 400 from Anthropic and OpenAI
 * alike. That image is durable by then, rehydrated into every later request:
 * the permanent session poisoning this whole seam exists to prevent.
 */
const PROVIDER_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Scale an image down so neither side exceeds `maxDimension`, preserving aspect
 * ratio and never upscaling.
 *
 * Distinct from `compressImage`, which triggers on *byte size* — a 5120x2880
 * screenshot that happens to compress small slips straight through that check.
 * Provider dimension limits are about pixels, so this one measures pixels.
 *
 * Format is preserved where canvas can encode it (notably PNG stays PNG, so a
 * screenshot with transparency does not gain a black background). An animated
 * GIF loses its animation, which is accepted: the alternative is an image the
 * route rejects, and a rejected image sits in durable history poisoning every
 * later request in the session.
 *
 * Never throws. Any decode/encode failure returns the input untouched — a
 * resize bug must not block the user from attaching a picture.
 */
export async function fitImageToDimension(
  input: CompressImageInput,
  maxDimension: number,
): Promise<FitImageResult> {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return input;

  try {
    const blob = new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mediaType });
    const bitmap = await createImageBitmap(blob);
    try {
      const { width, height } = bitmap;
      // Re-encode when the image is too big for the route OR when its type is
      // one no route accepts. Checking only the dimension produced a trap the
      // wrong way round: an oversized .bmp came out fixed (ENCODABLE excludes
      // bmp, so the resize path re-encoded it to PNG) while a small one sailed
      // through still labelled image/bmp — the same file poisoning the session
      // precisely because it was NOT big enough to trigger a resize.
      const fitsDimension = Math.max(width, height) <= maxDimension;
      if (fitsDimension && PROVIDER_SAFE.has(input.mediaType)) return input;

      const scale = fitsDimension ? 1 : maxDimension / Math.max(width, height);
      const toWidth = Math.max(1, Math.round(width * scale));
      const toHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = toWidth;
      canvas.height = toHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return input;
      ctx.drawImage(bitmap, 0, 0, toWidth, toHeight);

      const outType = ENCODABLE.has(input.mediaType) ? input.mediaType : 'image/png';
      const outBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), outType, DEFAULT_QUALITY);
      });
      if (!outBlob) return input;

      return {
        bytes: new Uint8Array(await outBlob.arrayBuffer()),
        mediaType: outType,
        // A pure format conversion keeps every pixel, so it is not a resize and
        // must not produce an <image_resize_notice> claiming otherwise.
        ...(fitsDimension ? {} : { resized: { fromWidth: width, fromHeight: height, toWidth, toHeight } }),
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return input;
  }
}
