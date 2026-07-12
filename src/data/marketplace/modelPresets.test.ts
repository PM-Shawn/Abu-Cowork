import { describe, it, expect } from 'vitest';
import { modelPresets } from './mcp';
import { PROVIDER_CONFIGS } from '@/stores/settingsStore';

describe('modelPresets consistency with PROVIDER_CONFIGS', () => {
  const configs = PROVIDER_CONFIGS as Record<string, { baseUrl: string; models: { id: string }[] }>;

  for (const preset of modelPresets) {
    const config = configs[preset.provider];
    // Only validate presets that target a builtin provider with a static model list
    // (skip local/ollama/custom which have empty models by design).
    if (!config || config.models.length === 0) continue;

    it(`preset "${preset.id}" model exists in PROVIDER_CONFIGS.${preset.provider}`, () => {
      const ids = config.models.map((m) => m.id);
      expect(ids).toContain(preset.model);
    });

    if (preset.baseUrl) {
      it(`preset "${preset.id}" baseUrl matches PROVIDER_CONFIGS.${preset.provider}`, () => {
        expect(preset.baseUrl).toBe(config.baseUrl);
      });
    }
  }
});
