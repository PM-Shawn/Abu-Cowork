import { describe, it, expect } from 'vitest';
import { PROVIDER_CONFIGS } from './settingsStore';
import { resolveCapabilities } from '@/core/llm/modelCapabilities';

const FORMATS = ['openai-compatible', 'anthropic'];

describe('provider config plans (multi-endpoint)', () => {
  it('volcengine/bailian/zhipu each have a plans array with >=2 entries', () => {
    for (const id of ['volcengine', 'bailian', 'zhipu'] as const) {
      const plans = (PROVIDER_CONFIGS as Record<string, { plans?: unknown[] }>)[id].plans;
      expect(Array.isArray(plans)).toBe(true);
      expect((plans as unknown[]).length).toBeGreaterThanOrEqual(2);
    }
  });
  it('every plan has non-empty baseUrl and a valid format (except custom, whose plans are a pure format switch — the user always types their own baseUrl, see design doc §7b)', () => {
    for (const [id, cfg] of Object.entries(PROVIDER_CONFIGS)) {
      for (const p of (cfg.plans ?? [])) {
        if (id !== 'custom') expect(p.baseUrl.length).toBeGreaterThan(0);
        expect(FORMATS).toContain(p.format);
      }
    }
  });
  it("custom's plans are the openai/anthropic format switch, both with an empty (user-supplied) baseUrl", () => {
    const plans = PROVIDER_CONFIGS.custom.plans!;
    expect(plans.map(p => p.id)).toEqual(['openai', 'anthropic']);
    for (const p of plans) {
      expect(p.baseUrl).toBe('');
    }
    expect(plans.find(p => p.id === 'openai')!.format).toBe('openai-compatible');
    expect(plans.find(p => p.id === 'anthropic')!.format).toBe('anthropic');
  });
  it('volcengine default (top-level) equals its Agent plan (OpenAI /api/plan/v3)', () => {
    const v = PROVIDER_CONFIGS.volcengine;
    const agent = v.plans!.find(p => p.id === 'agent')!;
    expect(v.baseUrl).toBe(agent.baseUrl);
    expect(v.format).toBe('openai-compatible');
    expect(agent.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/plan/v3');
  });
  it('plan models (when present) resolve to a sane context window', () => {
    const suspicious: string[] = [];
    for (const cfg of Object.values(PROVIDER_CONFIGS)) {
      for (const p of (cfg.plans ?? [])) {
        for (const m of (p.models ?? [])) {
          const caps = resolveCapabilities(m.id);
          if (!caps.contextWindow || caps.contextWindow < 1000) suspicious.push(m.id);
        }
      }
    }
    expect(suspicious).toEqual([]);
  });
  it('single-endpoint providers have no plans', () => {
    for (const id of ['openai', 'deepseek', 'anthropic'] as const) {
      expect((PROVIDER_CONFIGS as Record<string, { plans?: unknown }>)[id].plans).toBeUndefined();
    }
  });
});
