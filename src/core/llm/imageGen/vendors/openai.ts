import type { ImageGenParsedResult, ImageGenRequestBody, ImageGenRequestParams } from '../types';
import { normalizeOpenAiSize } from '../sizePolicy';

/**
 * Default OpenAI-shape request builder — also used as the fallback for the
 * 'custom' vendor (design doc §5: "custom/未知 → 默认 OpenAI-shape").
 *
 * gpt-image-1 special case: it does NOT accept `response_format` at all
 * (rejects the request if present) and always returns b64_json — so that
 * field is only added for other models (dall-e-3 and anything else).
 */
export function buildOpenAIRequest(params: ImageGenRequestParams): ImageGenRequestBody {
  const { model, prompt, size, style } = params;
  const body: ImageGenRequestBody = { model, prompt, n: 1 };

  if (!model.startsWith('gpt-image-1')) {
    body.response_format = 'b64_json';
  }

  if (size) {
    body.size = normalizeOpenAiSize(model, size);
  }

  // dall-e-3-only param; other models (gpt-image-1, custom-gateway models)
  // don't support/need it.
  if (model.startsWith('dall-e-3')) {
    body.style = style ?? 'vivid';
  }

  return body;
}

export function parseOpenAIResponse(json: unknown): ImageGenParsedResult {
  const data = (json as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> })?.data;
  const first = data?.[0];
  return { b64: first?.b64_json, url: first?.url, revisedPrompt: first?.revised_prompt };
}
