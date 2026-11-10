import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './settingsStore';

async function migrate(state: Record<string, unknown>, version: number) {
  return (await useSettingsStore.persist.getOptions().migrate!(state, version)) as Record<string, unknown>;
}

describe('V56 image-generation watermark setting', () => {
  it('turns the watermark on for a store saved before the setting existed', async () => {
    const migrated = await migrate({ imageGeneration: { backends: [] } }, 55);
    expect(migrated.imageGeneration).toEqual({ backends: [], watermark: true });
  });

  it('keeps a choice saved at V56 or later', async () => {
    const migrated = await migrate({ imageGeneration: { backends: [], watermark: false } }, 56);
    expect(migrated.imageGeneration).toEqual({ backends: [], watermark: false });
  });

  it('does not invent image settings that were never saved', async () => {
    const migrated = await migrate({}, 55);
    expect(migrated.imageGeneration).toBeUndefined();
  });

  it('defaults on and is changed by setImageGenWatermark', () => {
    expect(useSettingsStore.getState().imageGeneration.watermark).not.toBe(false);
    useSettingsStore.getState().setImageGenWatermark(false);
    expect(useSettingsStore.getState().imageGeneration.watermark).toBe(false);
    useSettingsStore.getState().setImageGenWatermark(true);
  });
});
