import type { ImageGenParsedResult, ImageGenRequestBody, ImageGenRequestParams } from '../types';

/**
 * SiliconFlow — field names diverge from OpenAI-shape (design doc §5):
 * `size` → `image_size`, `n` → `batch_size`. No `response_format`/b64
 * evidence in the docs, so we don't send it and only handle `url` on parse.
 * `size` is passed through unchanged (no known size-validation constraint to
 * snap against, unlike Seedream/dall-e-3) — just renamed onto `image_size`.
 */
export function buildSiliconFlowRequest(params: ImageGenRequestParams): ImageGenRequestBody {
  const { model, prompt, size } = params;
  const body: ImageGenRequestBody = { model, prompt, batch_size: 1 };

  if (size) {
    body.image_size = size;
  }

  return body;
}

/**
 * SiliconFlow's response envelope is `{ images: [...] }`, not OpenAI's
 * `{ data: [...] }` — must be normalized to the shared
 * `ImageGenParsedResult` shape here.
 */
export function parseSiliconFlowResponse(json: unknown): ImageGenParsedResult {
  const images = (json as { images?: Array<{ url?: string }> })?.images;
  return { url: images?.[0]?.url };
}
