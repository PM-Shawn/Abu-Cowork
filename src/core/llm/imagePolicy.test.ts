import { describe, it, expect } from 'vitest';
import { admissionMaxDimension, resolveImagePolicy } from './imagePolicy';

describe('resolveImagePolicy', () => {
  it('gives Anthropic the 2000px multi-image ceiling', () => {
    expect(resolveImagePolicy('claude-sonnet-4-6').maxDimension).toBe(2000);
    expect(resolveImagePolicy('claude-opus-4-8').maxDimension).toBe(2000);
  });

  // DeepSeek documents 8192px per side but drops to 4096px at 15+ images per
  // request. We take the stricter bound unconditionally so the limit does not
  // depend on how many images a given turn happens to carry.
  it('gives DeepSeek the stricter 4096px many-image bound, not the 8192px headline', () => {
    const policy = resolveImagePolicy('deepseek-v4-flash-vision-exp');
    expect(policy.maxDimension).toBe(4096);
    expect(policy.maxDimension).toBeLessThan(8192);
  });

  // The whole reason this module exists: one hardcoded number is wrong in both
  // directions across routes. If these ever converge, the policy is pointless.
  it('does not hand every route the same dimension', () => {
    const anthropic = resolveImagePolicy('claude-sonnet-4-6').maxDimension;
    const deepseek = resolveImagePolicy('deepseek-v4-flash-vision-exp').maxDimension;
    expect(anthropic).not.toBe(deepseek);
  });

  it('matches Codex-measured OpenAI dimensions for the gpt/o families', () => {
    expect(resolveImagePolicy('gpt-4o').maxDimension).toBe(2048);
    expect(resolveImagePolicy('o1-mini').maxDimension).toBe(2048);
  });

  it('strips an OpenRouter-style provider prefix before matching', () => {
    expect(resolveImagePolicy('anthropic/claude-sonnet-4-6').maxDimension).toBe(2000);
    expect(resolveImagePolicy('deepseek/deepseek-v4-flash').maxDimension).toBe(4096);
  });

  // Unknown ids are usually self-hosted or proxy gateways, which cap request
  // bodies tighter than model APIs — the 413 that motivated this module came
  // from a gateway. Guessing generously would reintroduce that failure.
  it('falls back to the strictest column for unknown routes', () => {
    const unknown = resolveImagePolicy('some-self-hosted-vlm-v3');
    expect(unknown.maxDimension).toBe(2000);

    const strictestDimension = Math.min(
      ...['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-4o', 'unknown-x']
        .map((id) => resolveImagePolicy(id).maxDimension),
    );
    expect(unknown.maxDimension).toBe(strictestDimension);
  });

  it('keeps every route on a positive, finite budget', () => {
    for (const id of ['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-4o', 'unknown-x']) {
      const policy = resolveImagePolicy(id);
      expect(policy.maxDimension).toBeGreaterThan(0);
      expect(policy.maxRequestImageBytes).toBeGreaterThan(0);
      expect(Number.isFinite(policy.maxRequestImageBytes)).toBe(true);
    }
  });
});

describe('admissionMaxDimension', () => {
  // Admission cannot size to the selected model: the user can attach with
  // DeepSeek selected and send on Claude, and by then the oversized image is
  // already in durable history — the poisoning failure, not a recoverable one.
  it('is the strictest ceiling any route declares', () => {
    const strictest = Math.min(
      ...['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-4o', 'unknown-x']
        .map((id) => resolveImagePolicy(id).maxDimension),
    );
    expect(admissionMaxDimension()).toBe(strictest);
  });

  it('is safe for every route, including the most permissive one', () => {
    for (const id of ['claude-sonnet-4-6', 'deepseek-v4-flash-vision-exp', 'gpt-4o', 'unknown-x']) {
      expect(admissionMaxDimension()).toBeLessThanOrEqual(resolveImagePolicy(id).maxDimension);
    }
  });

  // Derived, not hardcoded: adding a stricter route must tighten admission on its
  // own rather than leaving a silent gap for someone to notice later.
  it('tracks the table rather than restating a literal', () => {
    expect(admissionMaxDimension()).toBe(2000);
    expect(admissionMaxDimension()).toBeGreaterThan(0);
  });
});

// Pins the caveat documented on ImagePolicy.maxDimension: the per-route values
// feed a single global floor, so lowering any one of them tightens admission for
// every route. Someone adding a niche stricter provider should see this fail and
// realise the blast radius before shipping it.
describe('maxDimension is a global floor, not per-route enforcement', () => {
  it('admission tracks the strictest entry, so no route enforces its own value', () => {
    const perRoute = ['claude-sonnet-4-6', 'deepseek-v4-flash', 'gpt-4o', 'unknown-x']
      .map((id) => resolveImagePolicy(id).maxDimension);
    const admission = admissionMaxDimension();

    expect(admission).toBe(Math.min(...perRoute));
    // The looser routes genuinely do not get their own ceiling.
    expect(perRoute.some((value) => value > admission)).toBe(true);
  });
});
