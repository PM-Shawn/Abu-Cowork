export type CapabilityId =
  | 'abu-browser'
  | 'abu-browser-bridge'
  | 'abu-computer-use';

export type CapabilityKind = 'host-capability' | 'connector';
export type CapabilityInterfaceAccess = 'interactive' | 'read' | 'write';
export type CapabilityRuntimeType = 'electron-main' | 'mcp' | 'native-helper';
export type CapabilityLifecycle = 'host-managed' | 'store-managed' | 'on-demand';
export type CapabilityPermissionId = 'screen-read' | 'ui-control';
export type CapabilityDataScope =
  | 'isolated-browser-session'
  | 'existing-chrome-session'
  | 'screen-content';
export type CapabilityManagementTarget = 'capabilities' | 'mcp' | 'skills';
export type CapabilitySetupTarget = 'chrome' | 'computer';

export interface CapabilityManifest {
  schemaVersion: 1;
  id: CapabilityId;
  version: 1;
  origin: 'bundled';
  kind: CapabilityKind;
  interfaceCapabilities: CapabilityInterfaceAccess[];
  runtime: {
    type: CapabilityRuntimeType;
    id: string;
    lifecycle: CapabilityLifecycle;
  };
  permissions: CapabilityPermissionId[];
  dataScopes: CapabilityDataScope[];
  managementTarget: CapabilityManagementTarget;
  legacyIds: string[];
}

export type CapabilityStatusCode =
  | 'ready'
  | 'setup-required'
  | 'permission-required'
  | 'connection-lost'
  | 'unavailable';

export interface CapabilityPermissionState {
  id: CapabilityPermissionId;
  granted: boolean;
}

export interface CapabilityStatus {
  id: CapabilityId;
  code: CapabilityStatusCode;
  enabled: boolean;
  permissions: CapabilityPermissionState[];
  reason:
    | 'runtime-ready'
    | 'runtime-disconnected'
    | 'not-configured'
    | 'disabled'
    | 'missing-permission'
    | 'unsupported-shell'
    | 'probe-unavailable';
}

export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'reconnecting';

export interface CapabilityRuntimeSnapshot {
  electronCommandHost: boolean;
  builtinBrowserConnected: boolean;
  chromeBridge: {
    configured: boolean;
    enabled: boolean;
    status?: MCPConnectionStatus;
    extensionConnected?: boolean;
    /**
     * Whether the extension has EVER completed a handshake in this session.
     *
     * Without it, "the bridge process has not finished starting" is
     * indistinguishable from "this connection broke", and a machine that
     * never installed the extension reports a lost connection — then flips to
     * not-connected once the probe answers. The flag is monotonic, so the
     * classification does not depend on which of two concurrent probes lands
     * last.
     */
    extensionEverConnected?: boolean;
  };
  computerUse: {
    enabled: boolean;
    permissions?: {
      screenRead: boolean;
      uiControl: boolean;
    };
  };
}
