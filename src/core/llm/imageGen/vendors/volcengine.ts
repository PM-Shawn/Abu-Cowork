import type { ImageGenRequestBody, ImageGenRequestParams } from '../types';
import { normalizeSeedreamSize } from '../sizePolicy';
import { parseOpenAIResponse as parseVolcengineResponse } from './openai';

export { parseVolcengineResponse };

/**
 * Ark error codes `generate_image` explains to the user (Ark error-code doc).
 * `SetLimitExceeded` is one code for two caps, told apart only by its message: the usage cap of a
 * model (or 安心体验 mode) and the usage cap of one inference endpoint. `limit` is the code with
 * no message to tell which.
 */
export type VolcengineErrorKind =
  | 'limit'
  | 'limitModel'
  | 'limitEndpoint'
  | 'notOpen'
  | 'overdue'
  | 'sensitive'
  | 'badKey';

/**
 * Classify an Ark error body (`{"error":{"code":"SetLimitExceeded",…}}`) into the
 * cases a person can fix in the Ark console: a usage cap (of the model or of one
 * endpoint) or 安心体验 mode (SetLimitExceeded), a model that was never activated
 * (ModelNotOpen), an overdue account, content moderation of the input text or
 * image, and a missing or wrong API key. Anything else returns undefined and the
 * raw error stands on its own.
 */
export function classifyVolcengineError(body: string): VolcengineErrorKind | undefined {
  let code = '';
  let message = '';
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
  } catch {
    // not JSON; fall back to scanning the text
  }
  const text = code || body;
  if (/SetLimitExceeded/.test(text)) {
    // "...reached the set usage limit for the [<id>] model|endpoint, and the ... service has been paused."
    const scope = /usage limit for the (?:\[[^\]]*\]\s*)?(endpoint|model)\b/i.exec(message || body)?.[1];
    if (scope === undefined) return 'limit';
    return scope.toLowerCase() === 'endpoint' ? 'limitEndpoint' : 'limitModel';
  }
  if (/ModelNotOpen/.test(text)) return 'notOpen';
  if (/AccountOverdue/.test(text)) return 'overdue';
  if (/SensitiveContent|InputTextRiskDetection/.test(text)) return 'sensitive';
  if (/AuthenticationError|InvalidApiKey|InvalidAPIKey/i.test(text)) return 'badKey';
  return undefined;
}

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
