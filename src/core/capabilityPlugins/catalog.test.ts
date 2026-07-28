import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_IDS,
  getCapabilityManifest,
  listCapabilityManifests,
} from './catalog';

describe('capability catalog', () => {
  it('contains stable, unique IDs for the three V1 host capabilities', () => {
    const manifests = listCapabilityManifests();
    expect(manifests.map((manifest) => manifest.id)).toEqual([
      CAPABILITY_IDS.builtinBrowser,
      CAPABILITY_IDS.chromeBridge,
      CAPABILITY_IDS.computerUse,
    ]);
    expect(new Set(manifests.map((manifest) => manifest.id)).size).toBe(manifests.length);
  });

  it('keeps the built-in browser and Chrome bridge as separate runtimes and data scopes', () => {
    const builtin = getCapabilityManifest(CAPABILITY_IDS.builtinBrowser);
    const chrome = getCapabilityManifest(CAPABILITY_IDS.chromeBridge);

    expect(builtin.runtime).toEqual({
      type: 'electron-main',
      id: 'abu-browser',
      lifecycle: 'host-managed',
    });
    expect(builtin.dataScopes).toEqual(['isolated-browser-session']);
    expect(chrome.runtime).toEqual({
      type: 'mcp',
      id: 'abu-browser-bridge',
      lifecycle: 'store-managed',
    });
    expect(chrome.dataScopes).toEqual(['existing-chrome-session']);
  });

  it('declares Computer Use permissions without adding executable manifest fields', () => {
    const computerUse = getCapabilityManifest(CAPABILITY_IDS.computerUse);
    const serialized = JSON.stringify(computerUse);

    expect(computerUse.permissions).toEqual(['screen-read', 'ui-control']);
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"shell"');
    expect(serialized).not.toContain('"preload"');
  });

  it('returns defensive copies instead of mutable catalog references', () => {
    const first = getCapabilityManifest(CAPABILITY_IDS.builtinBrowser);
    first.legacyIds.push('mutated');
    const second = getCapabilityManifest(CAPABILITY_IDS.builtinBrowser);

    expect(second.legacyIds).toEqual(['Abu-Browser']);
  });
});
