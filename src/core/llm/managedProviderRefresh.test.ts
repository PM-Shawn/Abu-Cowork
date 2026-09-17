import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshManagedProvider, setManagedProviderRefresher } from './managedProviderRefresh';

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
