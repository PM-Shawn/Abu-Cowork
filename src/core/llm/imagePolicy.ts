/**
 * Per-route image policy.
 *
 * Image limits are a property of the *route* (provider deployment), not of Abu:
 * Anthropic rejects a multi-image request when any image exceeds 2000px on a
 * side, DeepSeek allows 8192px (4096px once a request carries 15+ images), and
 * OpenAI sizes by 32px patches. Abu is multi-provider, so a single hardcoded
 * number is wrong in both directions — 2000 needlessly rejects images DeepSeek
 * would happily read, 8192 earns a 400 from Anthropic.
 *
 * Before this module those thresholds were four unrelated magic numbers
 * (`SCREENSHOT_MAX_WIDTH`, `resizeImageIfNeeded`'s 1280, `getMaxScreenshots`,
 * `TOKENS_PER_IMAGE`), and none of them knew which route the turn was going to.
 * This is the one table they resolve from.
 *
 * Keyed on model id alone, mirroring `resolveCapabilities`' resolution order, so
 * no call site needs new plumbing — every consumer already has the model id.
 */

export interface ImagePolicy {
  /**
   * Largest allowed pixel length of either side. Images above it are downscaled
   * at admission (never silently — the model is told), not rejected.
   */
  maxDimension: number;
  /**
   * Ceiling on accumulated base64 image payload in a single request. Images are
   * dropped oldest-first once the total would exceed it.
   *
   * This bounds the failure DSH hit in production (deepseek-harness#2644): every
   * image in history is re-inlined into every request, so the body grows until a
   * gateway rejects it with 413 — and each retry resends the same oversized body,
   * wedging the session for good.
   */
  maxRequestImageBytes: number;
  /**
   * Tokens to charge one image when estimating context usage. Providers differ by
   * more than an order of magnitude, and over-charging is not harmless: it inflates
   * the water level and triggers an auto-compaction that costs a full LLM round trip.
   */
  tokensPerImage: number;
}

const MIB = 1024 * 1024;

/**
 * Anthropic. 2000px is the documented multi-image ceiling, observed firsthand in
 * the Claude Code binary ("dimension limit for many-image requests (2000px)").
 * ~1600 tokens/image matches Anthropic's published vision sizing.
 */
const ANTHROPIC_POLICY: ImagePolicy = {
  maxDimension: 2000,
  maxRequestImageBytes: 20 * MIB,
  tokensPerImage: 1600,
};

/**
 * DeepSeek. Official docs allow 8192px per side but drop to 4096px as soon as a
 * request carries 15 or more images; we take the stricter number unconditionally
 * rather than making the limit depend on how many images a turn happens to hold.
 * Images are resized to ~800x800 server-side and capped at 384 tokens each.
 */
const DEEPSEEK_POLICY: ImagePolicy = {
  maxDimension: 4096,
  maxRequestImageBytes: 32 * MIB,
  tokensPerImage: 384,
};

/**
 * OpenAI. Matches Codex's own `HIGH_DETAIL_LIMITS` (2048px) and its measured
 * ~1844 tokens for a resized image.
 */
const OPENAI_POLICY: ImagePolicy = {
  maxDimension: 2048,
  maxRequestImageBytes: 20 * MIB,
  tokensPerImage: 1844,
};

/**
 * Unknown routes take the strictest column on purpose. An unrecognized id is
 * usually a self-hosted or proxy gateway, and those cap request bodies *tighter*
 * than the model APIs do — the 413 that motivated this module was raised by a
 * gateway, not by a model endpoint. Guessing generously here would reintroduce
 * exactly the failure the policy exists to prevent.
 */
const FALLBACK_POLICY: ImagePolicy = {
  maxDimension: 2000,
  maxRequestImageBytes: 20 * MIB,
  tokensPerImage: 1600,
};

/**
 * Resolve the image policy for a model id.
 *
 * Mirrors `resolveCapabilities`: strip an OpenRouter-style `provider/` prefix,
 * then match on family. Unrecognized ids get the conservative fallback.
 */
export function resolveImagePolicy(modelId: string): ImagePolicy {
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  const id = bare.toLowerCase();

  if (/claude/.test(id)) return ANTHROPIC_POLICY;
  if (/deepseek/.test(id)) return DEEPSEEK_POLICY;
  if (/^o[1-9]|gpt-/.test(id)) return OPENAI_POLICY;

  return FALLBACK_POLICY;
}

const ALL_POLICIES = [ANTHROPIC_POLICY, DEEPSEEK_POLICY, OPENAI_POLICY, FALLBACK_POLICY];

/**
 * The pixel ceiling to enforce when an image is *admitted* (pasted, dropped, or
 * picked in the composer) — the strictest `maxDimension` any route declares.
 *
 * Admission deliberately ignores the currently selected model, for two reasons:
 *
 * 1. **The route is not decided yet.** Nothing stops the user attaching an image
 *    with DeepSeek selected and then switching to Claude before sending. Sizing
 *    to the route picked at attach time would leave that switch re-opening the
 *    exact 400 this guard exists to close, and the offending image would already
 *    be in durable history by then — the poisoning failure, not a recoverable one.
 *
 * 2. **A bigger admitted image buys no fidelity anyway.** Every route we target
 *    downsamples server-side regardless: DeepSeek resizes to roughly 800x800 and
 *    caps an image at 384 tokens, OpenAI sizes in 32px patches. Admitting 4096px
 *    instead of 2000px would not show the model one extra pixel — it would only
 *    add bytes to every request that image ever rides in.
 *
 * Derived from the table rather than hardcoded, so adding a stricter route
 * automatically tightens admission instead of silently leaving a gap.
 */
export function admissionMaxDimension(): number {
  return Math.min(...ALL_POLICIES.map((policy) => policy.maxDimension));
}
