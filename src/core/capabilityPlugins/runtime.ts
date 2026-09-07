import type { ComputerUsePermissions } from '../agent/computerUsePermission';
import { BUILTIN_BROWSER_SERVER_NAME } from '../browser/builtinBrowserRuntime';
import { mcpManager } from '../mcp/client';
import { hasElectronCommandHost } from '../../utils/electronHost';
import type {
  CapabilityRuntimeSnapshot,
  MCPConnectionStatus,
} from './types';

const CHROME_BRIDGE_SERVER_NAME = 'abu-browser-bridge';
const CHROME_STATUS_TOOL_NAME = 'connection_status';

export interface CapabilityRuntimeInputs {
  chromeBridge?: {
    enabled: boolean;
    status: MCPConnectionStatus;
    extensionConnected?: boolean;
    /** Monotonic: has the extension ever handshaked in this session. */
    extensionEverConnected?: boolean;
  };
  computerUseEnabled: boolean;
  computerUsePermissions?: ComputerUsePermissions;
}

/**
 * Project existing runtime ownership into the capability status model.
 * Callers supply reactive store values; this function does not subscribe,
 * connect, persist, or otherwise take over those stores.
 */
export function readCapabilityRuntimeSnapshot(
  inputs: CapabilityRuntimeInputs,
): CapabilityRuntimeSnapshot {
  return {
    electronCommandHost: hasElectronCommandHost(),
    builtinBrowserConnected: mcpManager.isConnected(BUILTIN_BROWSER_SERVER_NAME),
    chromeBridge: {
      configured: inputs.chromeBridge !== undefined,
      enabled: inputs.chromeBridge?.enabled ?? false,
      status: inputs.chromeBridge?.status,
      extensionConnected: inputs.chromeBridge?.extensionConnected,
      extensionEverConnected: inputs.chromeBridge?.extensionEverConnected,
    },
    computerUse: {
      enabled: inputs.computerUseEnabled,
      permissions: inputs.computerUsePermissions,
    },
  };
}

/**
 * Ask the existing Chrome bridge whether its extension is attached.
 *
 * The published bridge currently returns a short English status sentence.
 * Accept that legacy response and a future JSON form so this UI adapter can
 * evolve without taking ownership of the bridge protocol or process.
 */
export async function probeChromeBridgeConnection(): Promise<boolean | undefined> {
  if (!mcpManager.isConnected(CHROME_BRIDGE_SERVER_NAME)) return undefined;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      mcpManager.callTool(
        CHROME_BRIDGE_SERVER_NAME,
        CHROME_STATUS_TOOL_NAME,
        {},
      ),
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => resolve(undefined), 3_000);
      }),
    ]);
    if (typeof result !== 'string') return undefined;

    try {
      const parsed = JSON.parse(result) as { connected?: unknown };
      if (typeof parsed.connected === 'boolean') return parsed.connected;
    } catch {
      // The currently published bridge returns plain text.
    }

    if (result.includes('is connected and ready')) return true;
    if (result.includes('is not connected')) return false;
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
