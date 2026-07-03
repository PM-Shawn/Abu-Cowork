import { describe, it, expect, beforeEach } from 'vitest';
import { resolveLabsFlag, isLabsFlagOn } from './resolve';
import { useSettingsStore } from '@/stores/settingsStore';

describe('resolveLabsFlag', () => {
  it('falls back to the registry default when the user never toggled it', () => {
    // todos-inbox defaults to false
    expect(resolveLabsFlag('todos-inbox', {})).toBe(false);
  });

  it('honors an explicit user opt-in', () => {
    expect(resolveLabsFlag('todos-inbox', { 'todos-inbox': true })).toBe(true);
  });

  it('honors an explicit user opt-out even if it matches the default', () => {
    expect(resolveLabsFlag('todos-inbox', { 'todos-inbox': false })).toBe(false);
  });

  it('resolves unknown/orphan ids to false (graduated experiment left a stale key)', () => {
    expect(resolveLabsFlag('graduated-old-exp', { 'graduated-old-exp': true })).toBe(false);
  });
});

describe('isLabsFlagOn', () => {
  beforeEach(() => {
    useSettingsStore.setState({ labs: {} });
  });

  it('reads the live store', () => {
    expect(isLabsFlagOn('todos-inbox')).toBe(false);
    useSettingsStore.getState().setLabsFlag('todos-inbox', true);
    expect(isLabsFlagOn('todos-inbox')).toBe(true);
  });
});
