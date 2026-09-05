import { CAPABILITY_IDS } from './catalog';
import type {
  CapabilityId,
  CapabilityPermissionState,
  CapabilityRuntimeSnapshot,
  CapabilityStatus,
} from './types';

function permissionStates(
  screenRead: boolean,
  uiControl: boolean,
): CapabilityPermissionState[] {
  return [
    { id: 'screen-read', granted: screenRead },
    { id: 'ui-control', granted: uiControl },
  ];
}

export function deriveCapabilityStatuses(
  snapshot: CapabilityRuntimeSnapshot,
): Record<CapabilityId, CapabilityStatus> {
  const builtinBrowser: CapabilityStatus = !snapshot.electronCommandHost
    ? {
        id: CAPABILITY_IDS.builtinBrowser,
        code: 'unavailable',
        enabled: false,
        permissions: [],
        reason: 'unsupported-shell',
      }
    : snapshot.builtinBrowserConnected
      ? {
          id: CAPABILITY_IDS.builtinBrowser,
          code: 'ready',
          enabled: true,
          permissions: [],
          reason: 'runtime-ready',
        }
      : {
          id: CAPABILITY_IDS.builtinBrowser,
          code: 'connection-lost',
          enabled: true,
          permissions: [],
          reason: 'runtime-disconnected',
        };

  const chromeBridge: CapabilityStatus = !snapshot.chromeBridge.configured
    ? {
        id: CAPABILITY_IDS.chromeBridge,
        code: 'setup-required',
        enabled: false,
        permissions: [],
        reason: 'not-configured',
      }
    : !snapshot.chromeBridge.enabled
      ? {
          id: CAPABILITY_IDS.chromeBridge,
          code: 'setup-required',
          enabled: false,
          permissions: [],
          reason: 'disabled',
        }
      : snapshot.chromeBridge.extensionConnected === true
        ? {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'ready',
            enabled: true,
            permissions: [],
            reason: 'runtime-ready',
          }
        // The bridge is up but its status tool did not answer: genuinely
        // unknown, and not something the user can act on either way.
        : snapshot.chromeBridge.status === 'connected'
          && snapshot.chromeBridge.extensionConnected === undefined
        ? {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'unavailable',
            enabled: true,
            permissions: [],
            reason: 'probe-unavailable',
          }
        /*
          Nothing has ever handshaked, so there is no connection to have lost
          — this capability has simply never been set up. Checked BEFORE the
          runtime status because Abu starts the local bridge itself: a bridge
          that has not finished coming up is Abu's own startup, not a fault
          the user is supposed to read as one. Skipping this test is what made
          a machine with no extension installed report "connection lost" while
          the bridge connected, then flip to "not connected" once the probe
          answered — the same state, described two different ways depending on
          timing.
        */
        : !snapshot.chromeBridge.extensionEverConnected
        ? {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'setup-required',
            enabled: true,
            permissions: [],
            reason: 'not-configured',
          }
        // It worked before and does not now: a real regression, either way.
        : {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'connection-lost',
            enabled: true,
            permissions: [],
            reason: 'runtime-disconnected',
          };

  const computerPermissions = snapshot.computerUse.permissions;
  let computerUse: CapabilityStatus;
  if (!snapshot.computerUse.enabled) {
    computerUse = {
      id: CAPABILITY_IDS.computerUse,
      code: 'setup-required',
      enabled: false,
      permissions: computerPermissions
        ? permissionStates(computerPermissions.screenRead, computerPermissions.uiControl)
        : [],
      reason: 'disabled',
    };
  } else if (!computerPermissions) {
    computerUse = {
      id: CAPABILITY_IDS.computerUse,
      code: 'unavailable',
      enabled: true,
      permissions: [],
      reason: 'probe-unavailable',
    };
  } else if (!computerPermissions.screenRead || !computerPermissions.uiControl) {
    computerUse = {
      id: CAPABILITY_IDS.computerUse,
      code: 'permission-required',
      enabled: true,
      permissions: permissionStates(
        computerPermissions.screenRead,
        computerPermissions.uiControl,
      ),
      reason: 'missing-permission',
    };
  } else {
    computerUse = {
      id: CAPABILITY_IDS.computerUse,
      code: 'ready',
      enabled: true,
      permissions: permissionStates(true, true),
      reason: 'runtime-ready',
    };
  }

  return {
    [CAPABILITY_IDS.builtinBrowser]: builtinBrowser,
    [CAPABILITY_IDS.chromeBridge]: chromeBridge,
    [CAPABILITY_IDS.computerUse]: computerUse,
  };
}
