import { describe, expect, it } from 'vitest';
import { CAPABILITY_IDS } from './catalog';
import { deriveCapabilityStatuses } from './status';
import type { CapabilityRuntimeSnapshot } from './types';

const baseSnapshot: CapabilityRuntimeSnapshot = {
  electronCommandHost: true,
  builtinBrowserConnected: true,
  chromeBridge: {
    configured: true,
    enabled: true,
    status: 'connected',
    extensionConnected: true,
  },
  computerUse: {
    enabled: true,
    permissions: {
      screenRead: true,
      uiControl: true,
    },
  },
};

describe('deriveCapabilityStatuses', () => {
  it('reports all capabilities ready when their existing runtimes are ready', () => {
    const statuses = deriveCapabilityStatuses(baseSnapshot);

    expect(statuses[CAPABILITY_IDS.builtinBrowser].code).toBe('ready');
    expect(statuses[CAPABILITY_IDS.chromeBridge].code).toBe('ready');
    expect(statuses[CAPABILITY_IDS.computerUse].code).toBe('ready');
  });

  it('does not present the Electron browser as available in another shell', () => {
    const statuses = deriveCapabilityStatuses({
      ...baseSnapshot,
      electronCommandHost: false,
      builtinBrowserConnected: false,
    });

    expect(statuses[CAPABILITY_IDS.builtinBrowser]).toMatchObject({
      code: 'unavailable',
      enabled: false,
      reason: 'unsupported-shell',
    });
  });

  it('distinguishes unconfigured Chrome from a configured bridge that disconnected', () => {
    const notConfigured = deriveCapabilityStatuses({
      ...baseSnapshot,
      chromeBridge: { configured: false, enabled: false },
    });
    const disconnected = deriveCapabilityStatuses({
      ...baseSnapshot,
      chromeBridge: {
        configured: true,
        enabled: true,
        status: 'error',
        // What "disconnected" means: it handshaked at some point. Without
        // this the bridge has simply never come up, which is setup, not loss.
        extensionEverConnected: true,
      },
    });

    expect(notConfigured[CAPABILITY_IDS.chromeBridge].code).toBe('setup-required');
    expect(disconnected[CAPABILITY_IDS.chromeBridge].code).toBe('connection-lost');
  });

  it('does not claim My Chrome is ready when only the MCP process is connected', () => {
    const extensionMissing = deriveCapabilityStatuses({
      ...baseSnapshot,
      chromeBridge: {
        configured: true,
        enabled: true,
        status: 'connected',
        extensionConnected: false,
      },
    });
    const probeUnavailable = deriveCapabilityStatuses({
      ...baseSnapshot,
      chromeBridge: {
        configured: true,
        enabled: true,
        status: 'connected',
      },
    });

    expect(extensionMissing[CAPABILITY_IDS.chromeBridge]).toMatchObject({
      code: 'setup-required',
      enabled: true,
    });
    expect(probeUnavailable[CAPABILITY_IDS.chromeBridge]).toMatchObject({
      code: 'unavailable',
      reason: 'probe-unavailable',
    });
  });

  /*
    A machine that never installed the extension must describe itself the same
    way at every moment of startup. Before this, the local bridge coming up
    read as "connection lost" and then flipped to "not connected" once the
    probe answered — one state, two contradictory descriptions, decided by
    which of them the user happened to look at.
  */
  it('never reports a lost connection for an extension that never connected', () => {
    const everyStartupMoment = [
      { status: 'disconnected' as const, extensionConnected: undefined },
      { status: 'connecting' as const, extensionConnected: undefined },
      { status: 'error' as const, extensionConnected: undefined },
      { status: 'connected' as const, extensionConnected: false },
    ];

    for (const phase of everyStartupMoment) {
      const statuses = deriveCapabilityStatuses({
        ...baseSnapshot,
        chromeBridge: {
          configured: true,
          enabled: true,
          extensionEverConnected: false,
          ...phase,
        },
      });

      expect(statuses[CAPABILITY_IDS.chromeBridge], JSON.stringify(phase)).toMatchObject({
        code: 'setup-required',
        reason: 'not-configured',
      });
    }
  });

  // The flag is what separates the two, so it must survive a probe that comes
  // back false: the extension WAS there, so this is a regression to report.
  it('reports a lost connection once the extension has handshaked before', () => {
    const statuses = deriveCapabilityStatuses({
      ...baseSnapshot,
      chromeBridge: {
        configured: true,
        enabled: true,
        status: 'connected',
        extensionConnected: false,
        extensionEverConnected: true,
      },
    });

    expect(statuses[CAPABILITY_IDS.chromeBridge]).toMatchObject({
      code: 'connection-lost',
      reason: 'runtime-disconnected',
    });
  });

  it('keeps partial Computer Use permission visible instead of claiming ready', () => {
    const statuses = deriveCapabilityStatuses({
      ...baseSnapshot,
      computerUse: {
        enabled: true,
        permissions: {
          screenRead: true,
          uiControl: false,
        },
      },
    });

    expect(statuses[CAPABILITY_IDS.computerUse]).toMatchObject({
      code: 'permission-required',
      enabled: true,
      reason: 'missing-permission',
      permissions: [
        { id: 'screen-read', granted: true },
        { id: 'ui-control', granted: false },
      ],
    });
  });

  it('preserves the explicit opt-in state for Computer Use', () => {
    const statuses = deriveCapabilityStatuses({
      ...baseSnapshot,
      computerUse: {
        enabled: false,
        permissions: {
          screenRead: true,
          uiControl: true,
        },
      },
    });

    expect(statuses[CAPABILITY_IDS.computerUse]).toMatchObject({
      code: 'setup-required',
      enabled: false,
      reason: 'disabled',
    });
  });
});
