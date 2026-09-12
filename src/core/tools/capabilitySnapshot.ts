/**
 * Diagnostic projection of the same runtime inventory advertised to agents.
 * Configured offline tools remain visible with reasons. The policy probe is
 * name-only: actual calls still pass parameter, path, site and approval gates.
 */
import type { ToolDefinition } from '../../types';
import type { PermissionMode } from '../permissions/permissionMode';
import { getToolInventory } from './registry';
import type { InventorySource as CapabilitySource, InventoryReason } from './toolInventory';
import { useSettingsStore } from '../../stores/settingsStore';
import { getCurrentPolicy } from '../enterprise/policy/enforcer';
import { checkTool } from '../enterprise/policy/matcher';

export type { InventorySource as CapabilitySource, McpErrorCategory } from './toolInventory';
export { classifyMcpErrorCategory, sanitizeMcpError, summarizeMcpConnectionError } from './toolInventory';
export type UnavailableReason = InventoryReason | { kind: 'policy-denied'; reason?: string };

export type ConcurrencySafety = 'safe' | 'unsafe' | 'input-dependent';

export interface CapabilityEntry {
  name: string;
  source: CapabilitySource;
  /** Empty when the tool is fully active. */
  unavailableReasons: UnavailableReason[];
  concurrencySafety: ConcurrencySafety;
  /** Enterprise policy pre-check against this tool NAME with no concrete
   *  input — real for name-level policies, best-effort for input-dependent
   *  ones (the actual decision at call time may differ). */
  policy: { decision: 'allow' | 'confirm' | 'deny'; reason?: string };
}

export interface CapabilitySnapshot {
  permissionMode: PermissionMode;
  computerUseEnabled: boolean;
  entries: CapabilityEntry[];
}

function classifyConcurrencySafety(tool: ToolDefinition | undefined): ConcurrencySafety {
  if (!tool) return 'unsafe';
  if (typeof tool.isConcurrencySafe === 'function') return 'input-dependent';
  return tool.isConcurrencySafe === true ? 'safe' : 'unsafe';
}

function policyProbe(name: string): CapabilityEntry['policy'] {
  const result = checkTool(getCurrentPolicy(), name, '');
  return { decision: result.decision, reason: result.reason };
}

/**
 * Compute the full capability snapshot. Pure read — no side effects, no
 * network calls (runtime connections and stored diagnostics are read locally).
 */
export function computeCapabilitySnapshot(): CapabilitySnapshot {
  const entries: CapabilityEntry[] = getToolInventory().map((entry) => {
    const policy = policyProbe(entry.name);
    const unavailableReasons: UnavailableReason[] = [...entry.unavailableReasons];
    if (policy.decision === 'deny') {
      unavailableReasons.push({ kind: 'policy-denied', reason: policy.reason });
    }
    return {
      name: entry.name,
      source: entry.source,
      unavailableReasons,
      concurrencySafety: classifyConcurrencySafety(entry.definition),
      policy,
    };
  });

  const settings = useSettingsStore.getState();
  return {
    permissionMode: settings.permissionMode,
    computerUseEnabled: settings.computerUseEnabled,
    entries,
  };
}
