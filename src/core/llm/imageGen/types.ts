import type { ImageGenVendor } from '@/types/provider';

export type { ImageGenVendor };

/**
 * Vendor-agnostic input to `buildImageRequest` — the subset of
 * `generate_image`'s tool arguments that every vendor mapper needs. Kept
 * intentionally small (P3 scope): img2img reference images and vendor-only
 * extras (watermark, seed, guidance_scale, ...) are out of scope, see design
 * doc §10.
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
