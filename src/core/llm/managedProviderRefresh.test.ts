import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  readManagedProviderPersonalFallback,
  refreshManagedProvider,
  setManagedProviderPersonalFallback,
  setManagedProviderRefresher,
} from './managedProviderRefresh';

describe('managed provider personal fallback', () => {
  afterEach(() => setManagedProviderPersonalFallback('org', null));

  it('returns what the registered reader reports', () => {
    setManagedProviderPersonalFallback('org', () => ({ providerId: 'deepseek', modelId: 'deepseek-chat' }));
    expect(readManagedProviderPersonalFallback('org')).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' });
  });

  it('is null for a provider nobody registered, and again once the reader is cleared', () => {
    expect(readManagedProviderPersonalFallback('unknown')).toBeNull();
    setManagedProviderPersonalFallback('org', () => ({ providerId: 'deepseek', modelId: 'deepseek-chat' }));
    setManagedProviderPersonalFallback('org', null);
    expect(readManagedProviderPersonalFallback('org')).toBeNull();
  });
});

describe('managed provider refresh', () => {
  afterEach(() => setManagedProviderRefresher('org', null));

  it('runs the refresher registered for that provider and waits for it', async () => {
    let finished = false;
    setManagedProviderRefresher('org', async () => {
      await Promise.resolve();
      finished = true;
    });

    await refreshManagedProvider('org');

    expect(finished).toBe(true);
  });

  it('does nothing for a provider nobody registered', async () => {
    await expect(refreshManagedProvider('unknown')).resolves.toBeUndefined();
  });

  it('stops calling a refresher once it is cleared', async () => {
    const refresher = vi.fn().mockResolvedValue(undefined);
    setManagedProviderRefresher('org', refresher);
    setManagedProviderRefresher('org', null);

    await refreshManagedProvider('org');

    expect(refresher).not.toHaveBeenCalled();
  });
});
