import type { InstalledPlugin } from './installedStore';
import type { MCPServerConfig } from '@/core/mcp/client';

export interface PluginRuntimeSnapshot {
  enabled: boolean;
  servers: Record<string, MCPServerConfig | null>;
  disabledSkills: Record<string, boolean>;
  disabledAgents: Record<string, boolean>;
}
export interface PluginOperationResult {
  id: string;
  key: string;
  phase: 'prepared' | 'committed' | 'restored';
  runtime: PluginRuntimeSnapshot;
  expectedRuntime?: PluginRuntimeSnapshot;
  installed?: boolean;
}
export interface UnreadablePluginOperation { unreadable: true; fingerprint: string; backupPaths: string[] }
export type PluginOperationStatus = Pick<PluginOperationResult, 'id' | 'key' | 'phase'> | UnreadablePluginOperation | null;
type Action = 'begin' | 'commit' | 'rollback' | 'recover' | 'ack' | 'status' | 'archive' | 'configurationCleanupAllowed';
type Bridge = (action: Action, request: object) => Promise<unknown>;
function bridge(): Bridge {
  const host = (globalThis as typeof globalThis & { __ABU_SHELL__?: { pluginOperation?: Bridge } }).__ABU_SHELL__;
  if (!host?.pluginOperation) throw new Error('Plugin operations require the Electron desktop host');
  return host.pluginOperation;
}
export function hasPluginOperationHost(): boolean {
  return typeof (globalThis as typeof globalThis & { __ABU_SHELL__?: { pluginOperation?: Bridge } }).__ABU_SHELL__?.pluginOperation === 'function';
}
export async function beginPluginOperation(value: {
  kind: 'install' | 'update' | 'uninstall'; key: string; token?: string;
  record?: InstalledPlugin; expected: InstalledPlugin | null; runtime: PluginRuntimeSnapshot;
}): Promise<{ id: string; previous: InstalledPlugin | null }> {
  return await bridge()('begin', value) as { id: string; previous: InstalledPlugin | null };
}
export async function commitPluginOperation(id: string, record: InstalledPlugin | null, runtime: PluginRuntimeSnapshot): Promise<PluginOperationResult> {
  return await bridge()('commit', { id, record, runtime }) as PluginOperationResult;
}
export async function rollbackPluginOperation(id: string): Promise<PluginOperationResult> {
  return await bridge()('rollback', { id }) as PluginOperationResult;
}
export async function recoverPluginOperation(key?: string): Promise<PluginOperationResult | null> {
  return await bridge()('recover', key ? { key } : {}) as PluginOperationResult | null;
}
export async function pluginOperationStatus(): Promise<PluginOperationStatus> {
  return await bridge()('status', {}) as PluginOperationStatus;
}
export async function acknowledgePluginOperation(id: string): Promise<void> {
  await bridge()('ack', { id });
}

/** A commit response can be lost after durable commit: recover decides, not catch. */
export async function runPluginOperation<T>(ports: {
  begin: () => Promise<{ id: string }>;
  stage: () => Promise<T>;
  commit: (id: string, value: T) => Promise<PluginOperationResult>;
  apply: (result: PluginOperationResult) => Promise<void>;
  unchanged?: () => Promise<void>;
  recover?: () => Promise<PluginOperationResult | null>;
  acknowledge?: (id: string) => Promise<void>;
}): Promise<T> {
  const recover = ports.recover ?? recoverPluginOperation;
  const acknowledge = ports.acknowledge ?? acknowledgePluginOperation;
  let value: T | undefined;
  let staged = false;
  let committed = false;
  let operation: { id: string } | undefined;
  try {
    operation = await ports.begin();
    value = await ports.stage();
    staged = true;
    const resolution = await ports.commit(operation.id, value);
    committed = true;
    await ports.apply(resolution);
    await acknowledge(operation.id);
    return value;
  } catch (error) {
    // begin itself may have persisted a journal before its response failed.
    const resolution = await recover();
    if (resolution) {
      await ports.apply(resolution);
      await acknowledge(resolution.id);
      if (resolution.phase === 'committed' && operation && staged) return value as T;
    } else {
      if (committed && staged) return value as T;
      await ports.unchanged?.();
    }
    throw error;
  }
}

export async function archivePluginOperation(fingerprint: string): Promise<{ archivedPath: string; backupPaths: string[] }> {
  return await bridge()('archive', { fingerprint }) as { archivedPath: string; backupPaths: string[] };
}

export async function pluginConfigurationCleanupAllowed(): Promise<boolean> {
  return await bridge()('configurationCleanupAllowed', {}) === true;
}
