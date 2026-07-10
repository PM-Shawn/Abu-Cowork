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
  it('every plan has non-empty baseUrl and a valid format', () => {
    for (const cfg of Object.values(PROVIDER_CONFIGS)) {
      for (const p of (cfg.plans ?? [])) {
        expect(p.baseUrl.length).toBeGreaterThan(0);
        expect(FORMATS).toContain(p.format);
      }
    }
  });
  it('volcengine default (top-level) equals its Agent plan (Anthropic /api/plan)', () => {
    const v = PROVIDER_CONFIGS.volcengine;
    const agent = v.plans!.find(p => p.id === 'agent')!;
    expect(v.baseUrl).toBe(agent.baseUrl);
    expect(v.format).toBe('anthropic');
    expect(agent.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/plan');
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
