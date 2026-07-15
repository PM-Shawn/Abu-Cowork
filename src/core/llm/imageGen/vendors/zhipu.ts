import type { ImageGenParsedResult, ImageGenRequestBody, ImageGenRequestParams } from '../types';

/**
 * Zhipu (CogView) — UNCONFIRMED (design doc §5/§10: endpoint prefix is
 * inferred as `/api/paas/v4/images/generations`, and the response shape as
 * `data[].url`, but neither has been tested against a real key). Bracketed
 * here as an OpenAI-shape passthrough rather than left unimplemented, so
 * routing (`resolveImageVendor` → 'zhipu') at least degrades to "probably
 * works" instead of silently falling through to a different vendor's
 * assumptions. Revisit once real-key testing confirms or corrects this.
 */
export function buildZhipuRequest(params: ImageGenRequestParams): ImageGenRequestBody {
  const { model, prompt, size } = params;
  const body: ImageGenRequestBody = { model, prompt, n: 1 };

  // No confirmed size-constraint set for CogView — pass through unchanged
  // rather than guess a snapping rule (unlike Seedream/dall-e-3).
  if (size) {
    body.size = size;
  }

  return body;
}

export function parseZhipuResponse(json: unknown): ImageGenParsedResult {
  // b64_json support is unconfirmed for Zhipu; check for it defensively in
  // case the real API does return it, but `url` is the documented field.
  const data = (json as { data?: Array<{ url?: string; b64_json?: string }> })?.data;
  const first = data?.[0];
  return { url: first?.url, b64: first?.b64_json };
}
