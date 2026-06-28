import { describe, it, expect } from 'vitest';
import { PROVIDER_CONFIGS } from './settingsStore';
import { resolveCapabilities } from '@/core/llm/modelCapabilities';

describe('PROVIDER_CONFIGS consistency', () => {
  it('every listed model resolves to a sane (non-zero) context window', () => {
    const suspicious: string[] = [];
    for (const cfg of Object.values(PROVIDER_CONFIGS)) {
      for (const m of cfg.models) {
        const caps = resolveCapabilities(m.id);
        if (!caps.contextWindow || caps.contextWindow < 1000) suspicious.push(m.id);
      }
    }
    expect(suspicious).toEqual([]);
  });
});
