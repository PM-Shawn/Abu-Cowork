import type { CapabilityId, CapabilityManifest } from './types';

export const CAPABILITY_IDS = {
  builtinBrowser: 'abu-browser',
  chromeBridge: 'abu-browser-bridge',
  computerUse: 'abu-computer-use',
} as const satisfies Record<string, CapabilityId>;

const bundledCapabilities = [
  {
    schemaVersion: 1,
    id: CAPABILITY_IDS.builtinBrowser,
    version: 1,
    origin: 'bundled',
    kind: 'host-capability',
    interfaceCapabilities: ['interactive', 'read', 'write'],
    runtime: {
      type: 'electron-main',
      id: 'abu-browser',
      lifecycle: 'host-managed',
    },
    permissions: [],
    dataScopes: ['isolated-browser-session'],
    managementTarget: 'capabilities',
    legacyIds: ['Abu-Browser'],
  },
  {
    schemaVersion: 1,
    id: CAPABILITY_IDS.chromeBridge,
    version: 1,
    origin: 'bundled',
    kind: 'connector',
    interfaceCapabilities: ['interactive', 'read', 'write'],
    runtime: {
      type: 'mcp',
      id: 'abu-browser-bridge',
      lifecycle: 'store-managed',
    },
    permissions: [],
    dataScopes: ['existing-chrome-session'],
    managementTarget: 'mcp',
    legacyIds: ['Abu-Chrome-Bridge'],
  },
  {
    schemaVersion: 1,
    id: CAPABILITY_IDS.computerUse,
    version: 1,
    origin: 'bundled',
    kind: 'host-capability',
    interfaceCapabilities: ['interactive', 'read', 'write'],
    runtime: {
      type: 'native-helper',
      id: 'computer',
      lifecycle: 'on-demand',
    },
    permissions: ['screen-read', 'ui-control'],
    dataScopes: ['screen-content'],
    managementTarget: 'capabilities',
    legacyIds: ['Computer Use'],
  },
] as const satisfies readonly CapabilityManifest[];

export function listCapabilityManifests(): CapabilityManifest[] {
  return bundledCapabilities.map((manifest) => ({
    ...manifest,
    interfaceCapabilities: [...manifest.interfaceCapabilities],
    runtime: { ...manifest.runtime },
    permissions: [...manifest.permissions],
    dataScopes: [...manifest.dataScopes],
    legacyIds: [...manifest.legacyIds],
  }));
}

export function getCapabilityManifest(id: CapabilityId): CapabilityManifest {
  const manifest = bundledCapabilities.find((candidate) => candidate.id === id);
  if (!manifest) {
    throw new Error(`Unknown capability: ${id}`);
  }
  return {
    ...manifest,
    interfaceCapabilities: [...manifest.interfaceCapabilities],
    runtime: { ...manifest.runtime },
    permissions: [...manifest.permissions],
    dataScopes: [...manifest.dataScopes],
    legacyIds: [...manifest.legacyIds],
  };
}
