import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLabsFlag, isLabsFlagOn } from './resolve';
import { LABS_PET } from './registry';
import { useSettingsStore } from '@/stores/settingsStore';

// Uses LABS_PET as the sample registered experiment (todos-inbox is held back
// this release, so it's no longer in the registry). resolveLabsFlag treats any
// registered id uniformly — the pet UI happening to bind to petOpen instead of
// the labs map is a component-layer detail, irrelevant to this pure function.
describe('resolveLabsFlag', () => {
  it('falls back to the registry default when the user never toggled it', () => {
    expect(resolveLabsFlag(LABS_PET, {})).toBe(false); // pet defaults off
  });

  it('honors an explicit user opt-in', () => {
    expect(resolveLabsFlag(LABS_PET, { [LABS_PET]: true })).toBe(true);
  });

  it('honors an explicit user opt-out even if it matches the default', () => {
    expect(resolveLabsFlag(LABS_PET, { [LABS_PET]: false })).toBe(false);
  });

  it('resolves unknown/orphan ids to false (graduated/held-back experiment left a stale key)', () => {
    expect(resolveLabsFlag('graduated-old-exp', { 'graduated-old-exp': true })).toBe(false);
  });
});

describe('isLabsFlagOn', () => {
  beforeEach(() => {
    useSettingsStore.setState({ labs: {} });
  });

  it('reads the live store', () => {
    expect(isLabsFlagOn(LABS_PET)).toBe(false);
    useSettingsStore.getState().setLabsFlag(LABS_PET, true);
    expect(isLabsFlagOn(LABS_PET)).toBe(true);
  });
});
