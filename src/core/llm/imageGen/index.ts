import type { ImageGenVendor } from '@/types/provider';
import type { ImageGenParsedResult, ImageGenRequestBody, ImageGenRequestParams } from './types';
import { buildOpenAIRequest, parseOpenAIResponse } from './vendors/openai';
import { buildVolcengineRequest, parseVolcengineResponse } from './vendors/volcengine';
import { buildSiliconFlowRequest, parseSiliconFlowResponse } from './vendors/siliconflow';
import { buildZhipuRequest, parseZhipuResponse } from './vendors/zhipu';

export type { ImageGenVendor, ImageGenParsedResult, ImageGenRequestBody, ImageGenRequestParams };
export { resolveImageVendor } from './vendorResolve';
export { normalizeSeedreamSize, normalizeOpenAiSize } from './sizePolicy';

/**
 * Build the `/images/generations` request body for the given vendor
 * (design doc §5/P3 — per-vendor mapper registry). `custom`/unrecognized
 * vendors fall back to the default OpenAI-shape builder, same as `openai`.
 */
export function buildImageRequest(vendor: ImageGenVendor, params: ImageGenRequestParams): ImageGenRequestBody {
  switch (vendor) {
    case 'volcengine':
      return buildVolcengineRequest(params);
    case 'siliconflow':
      return buildSiliconFlowRequest(params);
    case 'zhipu':
      return buildZhipuRequest(params);
    case 'openai':
    case 'custom':
      return buildOpenAIRequest(params);
  }
}

/**
 * Parse a vendor's `/images/generations` JSON response into the shared
 * `{ b64?, url?, revisedPrompt? }` shape, normalizing envelope differences
 * (SiliconFlow's `images[]` vs everyone else's `data[]`).
 */
export function parseImageResponse(vendor: ImageGenVendor, json: unknown): ImageGenParsedResult {
  switch (vendor) {
    case 'volcengine':
      return parseVolcengineResponse(json);
    case 'siliconflow':
      return parseSiliconFlowResponse(json);
    case 'zhipu':
      return parseZhipuResponse(json);
    case 'openai':
    case 'custom':
      return parseOpenAIResponse(json);
  }
}
