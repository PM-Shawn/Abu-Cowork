/**
 * `discoveryStore` must not read `useEnterpriseStore` while it is being
 * evaluated.
 *
 * `stores/enterpriseStore` is a bare re-export of `@enterprise-modules`. OSS
 * resolves that alias to a stub with no edge back into `src/`, but an
 * enterprise build resolves it to the private overlay, whose entrypoint
 * side-effect-imports the mount-point components — and those reach back here
 * (`core/tools/builtins` → `definitions/agentTools` → `discoveryStore`). So in
 * an enterprise build this module can be evaluated *inside* enterpriseStore's
 * own evaluation, with the re-exported binding not yet initialized.
 *
 * A module-scope `useEnterpriseStore.subscribe(...)` therefore threw
 * `Cannot read properties of undefined (reading 'subscribe')` and took
 * `npm run test:enterprise` down at import time — while the OSS suite, which
 * never builds that cycle, stayed green. This test rebuilds the mid-cycle
 * shape with a mock so the OSS suite catches a regression on its own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The cyclic barrel, caught mid-evaluation: the namespace object exists, but
 * `useEnterpriseStore` is not populated until `settleEnterpriseStore()` runs —
 * which is what finishing the cycle does in a real enterprise build.
 */
let liveEnterpriseStore: { subscribe: ReturnType<typeof vi.fn> } | undefined;
const subscribe = vi.fn(() => () => {});
function settleEnterpriseStore(): void {
  liveEnterpriseStore = { subscribe };
}

vi.mock('./enterpriseStore', () => ({
  get useEnterpriseStore() {
    return liveEnterpriseStore;
  },
}));

vi.mock('../core/skill/loader', () => ({
  skillLoader: {
    discoverSkills: vi.fn().mockResolvedValue([]),
    getNameClaims: vi.fn().mockReturnValue([]),
    isBlockedByPolicy: vi.fn().mockReturnValue(false),
  },
}));
vi.mock('../core/agent/registry', () => ({
  agentRegistry: { discoverAgents: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
}));

describe('discoveryStore · enterprise import cycle', () => {
  beforeEach(() => {
    liveEnterpriseStore = undefined;
    subscribe.mockClear();
  });

  it('imports cleanly while the enterprise barrel is still mid-evaluation', async () => {
    await expect(import('./discoveryStore')).resolves.toBeDefined();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('subscribes to the policy once the cycle has settled, on the first scan', async () => {
    const { useDiscoveryStore } = await import('./discoveryStore');
    settleEnterpriseStore();

    await useDiscoveryStore.getState().refresh();
    expect(subscribe).toHaveBeenCalledTimes(1);

    // Registered once per process, not once per scan.
    await useDiscoveryStore.getState().refresh();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
