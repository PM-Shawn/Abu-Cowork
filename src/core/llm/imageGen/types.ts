import type { ImageGenVendor } from '@/types/provider';

export type { ImageGenVendor };

/**
 * Vendor-agnostic input to `buildImageRequest` — the subset of
 * `generate_image`'s tool arguments that vendor mappers need. Kept small
 * (P3 scope): vendor-only extras (watermark, seed, guidance_scale, ...) are
 * out of scope, see design doc §10. Reference images (img2img) are carried
 * here but only the Volcengine mapper puts them on the wire; the tool refuses
 * them for every other vendor before a request is built.
 */
export interface ImageGenRequestParams {
  model: string;
  prompt: string;
  /** Caller-requested size, e.g. "1024x1024". Omit to let the backend apply
   *  its own default. Per-vendor mappers normalize/snap this via
   *  `sizePolicy.ts` before putting it on the wire. */
  size?: string;
  /** DALL-E 3 only ('vivid' | 'natural'); ignored by other vendors. */
  style?: string;
  /** Reference images for image-to-image, multi-image fusion and style
   *  transfer. Each entry is already encoded for the wire: a `data:` URI or an
   *  http(s) URL. Order matters — the backend addresses them as image 1, 2, …. */
  referenceImages?: string[];
}

/** The JSON body a vendor mapper POSTs to `/images/generations` (or
 *  equivalent). Field names/shape are vendor-specific, hence `unknown`
 *  values rather than a single fixed interface. */
export type ImageGenRequestBody = Record<string, unknown>;

/** Vendor-agnostic output of `parseImageResponse`, after normalizing each
 *  vendor's response envelope (`data[]` vs `images[]`, etc). Exactly one of
 *  `b64`/`url` is expected to be set on success. */
export interface ImageGenParsedResult {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}
