/**
 * `MCPTemplate` is no longer data — it is a view over `BUILTIN_REGISTRY`, the
 * one catalog both the agent and 「市场」 read. These tests pin the mapping so
 * the view cannot drift from the registry the way the old hand-kept array did.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getMCPTemplate, getMCPTemplates, getMCPTemplatesForHost } from './mcp';
import { BUILTIN_REGISTRY, getRegistryEntry } from '@/core/agent/mcpDiscovery';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

function setElectronHost(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  runtime.__ABU_SHELL__ = enabled
    ? { mainSupervisesSidecar: true }
    : undefined;
}

afterEach(() => {
  setElectronHost(false);
});

describe('MCP templates derived from the registry', () => {
  it('maps one template per registry entry, keeping the name as the id', () => {
    const templates = getMCPTemplates();
    expect(templates).toHaveLength(BUILTIN_REGISTRY.length);
    expect(templates.map((template) => template.id)).toEqual(BUILTIN_REGISTRY.map((entry) => entry.name));
    for (const template of templates) {
      expect(template.name).toBe(template.id);
    }
  });

  /** The args a template installs are the ones this host would actually run. */
  it('carries the host-resolved command and args of its entry', () => {
    for (const template of getMCPTemplates()) {
      const resolved = getRegistryEntry(template.id)!;
      expect(template.command).toBe(resolved.command);
      expect(template.defaultArgs).toEqual(resolved.args);
    }
  });

  /**
   * The card renders a description in whichever locale the user is in, so both
   * must exist — and they come from the two dictionaries directly, not from
   * whatever locale happens to be active when the view is built.
   */
  it('describes every entry in both languages', () => {
    for (const template of getMCPTemplates()) {
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.descriptionEn?.length ?? 0).toBeGreaterThan(0);
      expect(template.description).toBe(zhCN.toolResult.system.mcpCatalog[template.id]);
      expect(template.descriptionEn).toBe(enUS.toolResult.system.mcpCatalog[template.id]);
      expect(template.description).not.toBe(template.descriptionEn);
    }
  });

  /**
   * `postgres` reads its connection string from argv — the one positional slot
   * a user must fill before the server can start. It reaches the install form
   * as a labeled argument field, not an env var.
   */
  it('turns a configurable positional argument into a labeled field', () => {
    const postgres = getMCPTemplate('postgres')!;
    expect(postgres.configurableArgs).toEqual([
      {
        index: 2,
        label: zhCN.toolResult.system.mcpArgLabels['postgres.2'],
        labelEn: enUS.toolResult.system.mcpArgLabels['postgres.2'],
        placeholder: 'postgresql://user:pass@localhost:5432/db',
      },
    ]);
    expect(postgres.configurableArgs![0].label).not.toBe(postgres.configurableArgs![0].labelEn);
    expect(postgres.requiredEnvVars ?? []).toHaveLength(0);
  });

  /** An env key becomes a secret slot: labeled by the key, hinted in both languages. */
  it('turns each env key into a required secret with a bilingual hint', () => {
    const brave = getMCPTemplate('brave-search')!;
    expect(brave.requiredEnvVars).toHaveLength(1);
    const [key] = brave.requiredEnvVars!;
    expect(key.name).toBe('BRAVE_API_KEY');
    expect(key.label).toBe('BRAVE_API_KEY');
    expect(key.placeholder).toBe('BSA...');
    expect(key.description?.length ?? 0).toBeGreaterThan(0);
    expect(key.descriptionEn?.length ?? 0).toBeGreaterThan(0);
    expect(key.description).not.toBe(key.descriptionEn);
  });

  it('leaves a template with no env and no positional slot free of both', () => {
    const memory = getMCPTemplate('memory')!;
    expect(memory.requiredEnvVars ?? []).toHaveLength(0);
    expect(memory.configurableArgs ?? []).toHaveLength(0);
  });

  it('resolves nothing for a name the registry does not carry', () => {
    expect(getMCPTemplate('sqlite')).toBeUndefined();
  });
});

describe('MCP marketplace host filtering', () => {
  it('hides the first-party Chrome bridge template in Electron', () => {
    setElectronHost(true);

    expect(getMCPTemplatesForHost().some(
      (template) => template.id === 'abu-browser-bridge',
    )).toBe(false);
    expect(getMCPTemplatesForHost()).toHaveLength(BUILTIN_REGISTRY.length - 1);
  });

  it('preserves the legacy Chrome bridge template for Tauri', () => {
    setElectronHost(false);

    expect(getMCPTemplatesForHost()).toHaveLength(BUILTIN_REGISTRY.length);
    const bridge = getMCPTemplatesForHost().find((template) => template.id === 'abu-browser-bridge')!;
    expect(bridge.command).toBe('npx');
    expect(bridge.defaultArgs).toEqual(['-y', 'abu-browser-bridge@latest']);
    // The Chrome extension is a step outside Abu, and browser automation waits
    // on real pages — both travel with the template, in both languages.
    expect(bridge.setupHint?.length ?? 0).toBeGreaterThan(0);
    expect(bridge.setupHintEn?.length ?? 0).toBeGreaterThan(0);
    expect(bridge.defaultTimeout).toBe(120000);
  });
});
