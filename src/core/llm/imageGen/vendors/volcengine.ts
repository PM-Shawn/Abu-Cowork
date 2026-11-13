import type { ImageGenRequestBody, ImageGenRequestParams } from '../types';
import { isSeedream5ProOrFlash, normalizeSeedreamSize } from '../sizePolicy';
import { parseOpenAIResponse as parseVolcengineResponse } from './openai';

export { parseVolcengineResponse };

/** Reference images one request may carry: 10 for Seedream 5.0 pro/flash, 14
 *  for 5.0 lite / 4.5 / 4.0 (Ark image-generation API doc, 2026-10-14). */
export function volcengineMaxReferenceImages(model: string | undefined): number {
  return isSeedream5ProOrFlash(model) ? 10 : 14;
}

/**
 * Volcengine Ark (Seedream) — request shape is highly compatible with
 * OpenAI's (design doc §5), so this only differs from the default path in
 * the size contract (`normalizeSeedreamSize`, which depends on the model).
 * `watermark` is a vendor extra (design doc §5) that the API turns ON when it
 * is omitted, stamping an "AI generated" mark into every picture; users want
 * clean images, so it is always sent as false. `generate_image`'s inputSchema
 * has no surface for it, so it is not configurable per call.
 */
export function buildVolcengineRequest(params: ImageGenRequestParams): ImageGenRequestBody {
  const { model, prompt, size, referenceImages, watermark = true } = params;
  const body: ImageGenRequestBody = { model, prompt, n: 1, response_format: 'b64_json', watermark };

  if (size) {
    body.size = normalizeSeedreamSize(size, model);
  }

  // `image` takes one string or an array (up to 10 or 14 entries, see
  // `volcengineMaxReferenceImages`), referred to as 图1/图2… in array order. A
  // lone image is sent as a plain string to match the docs' single-image example. `sequential_image_generation` is deliberately never
  // sent: Seedream 5.0 Flash/Pro reject the field even when set to "disabled".
  if (referenceImages?.length) {
    body.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages;
  }

  return body;
}
