import type { ApiFormat } from '@/types';

/**
 * Remove surrounding whitespace and trailing slashes from a user-provided base URL.
 * Idempotent and safe on empty strings.
 */
export function normalizeBaseUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Given a normalized base URL, return the value the OpenAI-compatible adapter
 * will actually POST to after its /v1 auto-append rule. Mirrors the logic in
 * openai-compatible.ts chat(). Keeps UI preview and real request in lockstep.
 */
export function resolveOpenAIBaseUrl(raw: string | undefined | null): string {
  let base = normalizeBaseUrl(raw) || 'https://api.openai.com/v1';
  if (!base.match(/\/v\d+$/)) base += '/v1';
  return base;
}

/**
 * Idempotently ensure a URL ends in exactly one /chat/completions,
 * stripping any repeats and preserving ?query / #fragment suffixes.
 */
export function normalizeChatCompletionsUrl(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  const cut = s.search(/[?#]/);
  const suffix = cut >= 0 ? s.slice(cut) : '';
  let base = (cut >= 0 ? s.slice(0, cut) : s).replace(/\/+$/, '');
  while (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  base = resolveOpenAIBaseUrl(base);
  return `${base}/chat/completions${suffix}`;
}

/**
 * Idempotently ensure a URL ends in exactly one /images/generations,
 * stripping any repeats and preserving ?query / #fragment suffixes.
 *
 * Image-gen backends are entered by hand in Settings → Image Generation, and
 * vendor docs (e.g. Volcengine Ark) present the FULL endpoint
 * `https://ark.cn-beijing.volces.com/api/v3/images/generations` as the thing to
 * copy — so users paste the full path just as often as the bare base. Without
 * this, `resolveOpenAIBaseUrl(base) + '/images/generations'` would turn a pasted
 * full URL into `.../api/v3/images/generations/v1/images/generations` (404).
 */
export function normalizeImageGenerationsUrl(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  const cut = s.search(/[?#]/);
  const suffix = cut >= 0 ? s.slice(cut) : '';
  let base = (cut >= 0 ? s.slice(0, cut) : s).replace(/\/+$/, '');
  while (base.endsWith('/images/generations')) base = base.slice(0, -'/images/generations'.length);
  base = resolveOpenAIBaseUrl(base);
  return `${base}/images/generations${suffix}`;
}

/**
 * Build the full chat endpoint URL the app will hit for a given provider config.
 * Used by the adapter (to POST) and by the settings UI (to preview for the user).
 *
 * For openai-compatible: idempotently normalizes to .../chat/completions so a
 * user-pasted full URL (e.g. https://api.x/v1/chat/completions) is not
 * double-appended. Pass opts.useRawUrl to skip the /chat/completions path
 * normalization — the URL is used as-is apart from trimming whitespace and
 * trailing slashes (via normalizeBaseUrl). Intended for proxies with non-standard
 * endpoint paths where auto-appending /v1/chat/completions is wrong.
 */
export function buildFullChatUrl(
  rawBaseUrl: string | undefined | null,
  format: ApiFormat,
  opts?: { useRawUrl?: boolean },
): string {
  if (format === 'anthropic') {
    const base = normalizeBaseUrl(rawBaseUrl) || 'https://api.anthropic.com';
    return `${base}/v1/messages`;
  }
  if (opts?.useRawUrl) return normalizeBaseUrl(rawBaseUrl);
  return normalizeChatCompletionsUrl(rawBaseUrl);
}
