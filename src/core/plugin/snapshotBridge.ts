import type { PluginSource } from './marketplace';
import type { PackageEntry, PackageScan } from './fsOps';
import { normalizeSeparators } from '@/utils/pathUtils';

export interface PluginSnapshot {
  token: string;
  authoringId?: string;
  packageDir: string;
  sourceDir: string;
  checksum: string;
  source: PluginSource;
  version: string;
  skippedSymlinks: string[];
}

type Action = 'prepare' | 'inspect' | 'read' | 'validate' | 'materialize' | 'release';

async function request<T>(action: Action, value: object): Promise<T> {
  const bridge = (globalThis as typeof globalThis & {
    __ABU_SHELL__?: { pluginSnapshot?: (action: Action, value: object) => Promise<unknown> };
  }).__ABU_SHELL__?.pluginSnapshot;
  if (!bridge) throw new Error('Plugin preparation requires the Electron desktop host');
  return await bridge(action, value) as T;
}

export const preparePluginSnapshot = (value: { marketplaceDir: string; marketplaceName: string; entryName: string }) => request<PluginSnapshot>('prepare', value);
export const validatePluginSnapshot = (token: string) => request<{ valid: true }>('validate', { token });
export const materializePluginSnapshot = (token: string) => request<{ targetDir: string; checksum: string; agents: string[] }>('materialize', { token });
export const releasePluginSnapshot = (token: string) => request<{ released: boolean }>('release', { token });

/** Adapts existing parsers to token-owned memory, without filesystem fallback. */
export async function snapshotReader(snapshot: PluginSnapshot): Promise<{ scan: PackageScan; readText: (path: string) => Promise<string> }> {
  const index = await request<{ path: string; isDirectory: boolean }[]>('inspect', { token: snapshot.token });
  const entries = new Map<string, PackageEntry>(index.map(entry => [entry.path, {
    name: entry.path.slice(entry.path.lastIndexOf('/') + 1), isDirectory: entry.isDirectory,
  }]));
  const prefix = normalizeSeparators(snapshot.packageDir).replace(/\/$/, '') + '/';
  return {
    scan: {
      find: async path => entries.get(path),
      children: async path => [...entries].filter(([name]) => name.slice(0, Math.max(0, name.lastIndexOf('/'))) === path).map(([, entry]) => entry),
    },
    readText: async path => {
      const normalized = normalizeSeparators(path);
      if (!normalized.startsWith(prefix)) throw new Error('Plugin snapshot: file outside package');
      const relative = normalized.slice(prefix.length);
      if (!entries.has(relative) || entries.get(relative)?.isDirectory) throw new Error('Plugin snapshot: file unavailable');
      return request<string>('read', { token: snapshot.token, path: relative });
    },
  };
}
