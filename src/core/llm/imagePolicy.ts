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
 * Before this module those thresholds were unrelated magic numbers
 * (`SCREENSHOT_MAX_WIDTH`, `resizeImageIfNeeded`'s 1280, `getMaxScreenshots`),
 * none of which knew which route the turn was going to. This is the one table
 * they resolve from.
 *
 * Per-image token pricing deliberately does NOT live here. It was tried and
 * withdrawn: the only per-turn route identity available to `tokenEstimator` is a
 * module global that concurrent conversations overwrite, and that number feeds
 * the INPUT_TOO_LARGE refusal — borrowing another conversation's route could
 * under-count and wave an oversized request past the guard. See the comment on
 * `TOKENS_PER_IMAGE` in tokenEstimator.ts.
 *
 * Keyed on model id alone, mirroring `resolveCapabilities`' resolution order, so
 * no call site needs new plumbing — every consumer already has the model id.
 */

import { resolveModelFamily } from './model-data/families';

export interface ImagePolicy {
  /**
   * The route's own pixel ceiling on either side, as its provider documents it.
   *
   * ⚠️ Read today by `admissionMaxDimension()` only, which takes the MINIMUM
   * across every route — so the effective admission limit is the strictest entry
   * here, and a route's own larger value never loosens anything for it. Lowering
   * one route therefore tightens admission for ALL routes. Kept per-route because
   * it documents where each number comes from and makes the floor self-updating,
   * not because each route is enforced separately.
   */
  maxDimension: number;
  /**
   * What the provider REJECTS: a picture with a side above this earns a 400 and
   * the run ends. It is not `maxDimension`: that is the size pictures are FITTED
   * to at entry (composer, read_file), picked small and the same for every route
   * because the route is not known then. The send-time judge (imageAcceptance.ts)
   * uses this one, so a picture the route takes is never dropped for being above
   * the entry size. `Infinity` for a route that scales instead of rejecting.
   * Sources are named on each policy below.
   */
  rejectDimension: number;
  /**
   * What the provider rejects per picture, in base64 characters (the unit of the
   * request body). The entry fit and the send-time judge both use the strictest
   * route's value (`admissionMaxImageBytes`), because a picture stored in
   * history is re-sent on every later turn, on whichever route is then selected.
   */
  maxImageBytes: number;
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
}

const MIB = 1024 * 1024;

/**
 * Anthropic. 2000px is the documented multi-image ceiling, observed firsthand in
 * the Claude Code binary ("dimension limit for many-image requests (2000px)").
 */
const ANTHROPIC_POLICY: ImagePolicy = {
  maxDimension: 2000,
  // Vision docs (platform.claude.com/docs/en/build-with-claude/vision): 8000x8000 px for a
  // single image, 3000 px once a request holds more than 20 image blocks (not modelled here:
  // pictures fitted at entry are 2000 px, and only a tool picture of 3001-8000 px in a request of
  // 20+ pictures could still be refused). Per image: 10 MB base64 on the Claude API, 5 MB on
  // Amazon Bedrock; the same model id can be served by either, so the 5 MB is used.
  rejectDimension: 8000,
  maxImageBytes: 5 * MIB,
  maxRequestImageBytes: 20 * MIB,
};

/**
 * DeepSeek. Official docs allow 8192px per side but drop to 4096px as soon as a
 * request carries 15 or more images; we take the stricter number unconditionally
 * rather than making the limit depend on how many images a turn happens to hold.
 */
const DEEPSEEK_POLICY: ImagePolicy = {
  maxDimension: 4096,
  // 8192 px per the docs above, and observed: a 10032x4178 PNG earned 400 "unsupported
  // image". No per-image byte limit is documented; the request budget below bounds the body.
  rejectDimension: 8192,
  maxImageBytes: 20 * MIB,
  maxRequestImageBytes: 32 * MIB,
};

/**
 * OpenAI. Matches Codex's own `HIGH_DETAIL_LIMITS` (2048px).
 */
const OPENAI_POLICY: ImagePolicy = {
  maxDimension: 2048,
  // developers.openai.com/api/docs/guides/images-vision: high detail scales a picture to fit
  // 2048 px (newer models: a patch budget), so a larger side is not refused; only a picture
  // that stays above 30,000 patches after scaling is, which a side limit cannot express. The
  // docs give a 512 MB request payload and no per-image figure; 20 MiB is the long-standing
  // per-image file limit.
  rejectDimension: Infinity,
  maxImageBytes: 20 * MIB,
  maxRequestImageBytes: 20 * MIB,
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
  // An unknown gateway may front any of the above: the strictest documented rejection,
  // Claude's many-image 3000 px, and the strictest per-image bytes.
  rejectDimension: 3000,
  maxImageBytes: 5 * MIB,
  maxRequestImageBytes: 20 * MIB,
};

/**
 * Resolve the image policy for a model id.
 *
 * Keyed on the model family (`model-data/families.ts`). Unrecognized ids get
 * the conservative fallback.
 */
export function resolveImagePolicy(modelId: string): ImagePolicy {
  switch (resolveModelFamily(modelId)) {
    case 'claude': return ANTHROPIC_POLICY;
    case 'deepseek': return DEEPSEEK_POLICY;
    case 'gpt': return OPENAI_POLICY;
    default: return FALLBACK_POLICY;
  }
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

/**
 * The per-image byte ceiling for a picture being ADMITTED (composer, read_file, any fit
 * step): the strictest `maxImageBytes` of any route, for the reason `admissionMaxDimension`
 * gives.
 */
export function admissionMaxImageBytes(): number {
  return Math.min(...ALL_POLICIES.map((policy) => policy.maxImageBytes));
}

/**
 * The limits the send-time judge enforces for a route, under the option names
 * `normalizeMessages` reads. Adapters spread this into their options.
 */
export function imageAcceptanceLimits(modelId: string): { maxImageDimension: number; maxImageBytes: number } {
  const policy = resolveImagePolicy(modelId);
  return { maxImageDimension: policy.rejectDimension, maxImageBytes: policy.maxImageBytes };
}
