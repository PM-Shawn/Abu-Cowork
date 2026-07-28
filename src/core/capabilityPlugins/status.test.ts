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
