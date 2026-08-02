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
      : snapshot.chromeBridge.status !== 'connected'
        ? {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'connection-lost',
            enabled: true,
            permissions: [],
            reason: 'runtime-disconnected',
          }
        : snapshot.chromeBridge.extensionConnected === true
        ? {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'ready',
            enabled: true,
            permissions: [],
            reason: 'runtime-ready',
          }
        : snapshot.chromeBridge.extensionConnected === false
          ? {
              id: CAPABILITY_IDS.chromeBridge,
              code: 'setup-required',
              enabled: true,
              permissions: [],
              reason: 'not-configured',
            }
        : {
            id: CAPABILITY_IDS.chromeBridge,
            code: 'unavailable',
            enabled: true,
            permissions: [],
            reason: 'probe-unavailable',
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
