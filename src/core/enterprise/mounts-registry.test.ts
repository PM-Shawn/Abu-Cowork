import { describe, it, expect } from 'vitest';
import type { ComponentType } from 'react';
import { getEnterpriseMount, registerEnterpriseMount, type TabSlotProps } from './mounts-registry';

describe('mounts-registry pluginTab slot', () => {
  it('is undefined until a private module registers it (optional slot, like agentMarket)', () => {
    expect(getEnterpriseMount('pluginTab')).toBeUndefined();
  });

  it('returns the registered component', () => {
    const Impl = (() => null) as unknown as ComponentType<TabSlotProps>;
    registerEnterpriseMount('pluginTab', Impl);
    expect(getEnterpriseMount('pluginTab')).toBe(Impl);
  });
});
