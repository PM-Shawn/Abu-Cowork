import type { ImageGenRequestBody, ImageGenRequestParams } from '../types';
import { normalizeSeedreamSize } from '../sizePolicy';
import { parseOpenAIResponse as parseVolcengineResponse } from './openai';

export { parseVolcengineResponse };

/**
 * Volcengine Ark (Seedream) — request shape is highly compatible with
 * OpenAI's (design doc §5), so this only differs from the default path in
 * the size floor (`normalizeSeedreamSize`). `watermark` is an optional
 * vendor extra (design doc §5) but `generate_image`'s inputSchema has no
 * surface for it yet, so it's intentionally omitted rather than defaulted.
 */
export function buildVolcengineRequest(params: ImageGenRequestParams): ImageGenRequestBody {
  const { model, prompt, size } = params;
  const body: ImageGenRequestBody = { model, prompt, n: 1, response_format: 'b64_json' };

  if (size) {
    body.size = normalizeSeedreamSize(size);
  }

  return body;
}
