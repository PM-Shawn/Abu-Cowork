import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAdapter,
  unregisterAdapter,
  listAdapters,
  getAdapter,
  __resetAdaptersForTests,
} from './index';
import type { RegistryAdapter } from './types';

function makeAdapter(id: string, overrides: Partial<RegistryAdapter> = {}): RegistryAdapter {
  return {
    id,
    displayName: `adapter-${id}`,
    capabilities: { canList: true, canSearch: true, requiresAuth: false },
    isAvailable: async () => true,
    install: async () => new Uint8Array(),
    ...overrides,
  };
}

beforeEach(() => {
  __resetAdaptersForTests();
});

describe('registry · registerAdapter / listAdapters', () => {
  it('stores an adapter and returns it via list + get', () => {
    const a = makeAdapter('clawhub');
    registerAdapter(a);
    expect(listAdapters()).toHaveLength(1);
    expect(getAdapter('clawhub')).toBe(a);
  });

  it('preserves insertion order in listAdapters', () => {
    registerAdapter(makeAdapter('z-first'));
    registerAdapter(makeAdapter('a-second'));
    registerAdapter(makeAdapter('m-third'));
    expect(listAdapters().map((a) => a.id)).toEqual(['z-first', 'a-second', 'm-third']);
  });

  it('replaces an existing adapter when registering the same id again', () => {
    // Useful for tests that want to swap mocks; also keeps hot-reload
    // sane (no "already registered" errors on dev restart).
    const first = makeAdapter('skillshub', { displayName: 'v1' });
    const second = makeAdapter('skillshub', { displayName: 'v2' });
    registerAdapter(first);
    registerAdapter(second);
    expect(listAdapters()).toHaveLength(1);
    expect(getAdapter('skillshub')?.displayName).toBe('v2');
  });
});

describe('registry · unregisterAdapter', () => {
  it('removes an adapter and returns true', () => {
    registerAdapter(makeAdapter('clawhub'));
    expect(unregisterAdapter('clawhub')).toBe(true);
    expect(getAdapter('clawhub')).toBeUndefined();
  });

  it('returns false when asked to remove a non-existent id', () => {
    expect(unregisterAdapter('never-registered')).toBe(false);
  });
});

describe('registry · getAdapter', () => {
  it('returns undefined (never throws) for unknown ids', () => {
    // UI pattern is "show if present", not "crash if absent".
    expect(getAdapter('bogus')).toBeUndefined();
  });
});
