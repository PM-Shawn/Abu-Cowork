import { describe, it, expect, beforeAll } from 'vitest';

// All persisted stores must be registered here.
// When adding a new persist store, add it to this list — otherwise this test fails.
const PERSISTED_STORES = [
  { key: 'abu-settings', minVersion: 6 },
  { key: 'abu-chat', minVersion: 2 },
  { key: 'abu-scratchpad-store', minVersion: 1 },
  { key: 'abu-permissions', minVersion: 1 },
  { key: 'abu-workspace', minVersion: 1 },
  { key: 'abu-mcp-store', minVersion: 1 },
  { key: 'abu-schedule', minVersion: 1 },
  { key: 'abu-triggers', minVersion: 2 },
  { key: 'abu-im-channel', minVersion: 1 },
] as const;

// Import all stores to trigger persist initialization
beforeAll(async () => {
  await import('./settingsStore');
  await import('./chatStore');
  await import('./scratchpadStore');
  await import('./permissionStore');
  await import('./workspaceStore');
  await import('./mcpStore');
  await import('./scheduleStore');
  await import('./triggerStore');
  await import('./imChannelStore');
});

describe('Store version compliance', () => {
  it('all persisted stores should have version in their stored data', () => {
    for (const { key, minVersion } of PERSISTED_STORES) {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        expect(parsed.version, `${key} missing or outdated version`).toBeGreaterThanOrEqual(minVersion);
      }
    }
  });

  it('registry should cover all abu-* keys in localStorage', () => {
    const registeredKeys = new Set(PERSISTED_STORES.map((s) => s.key));
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('abu-')) {
        expect(registeredKeys.has(key), `localStorage key "${key}" not registered in PERSISTED_STORES`).toBe(true);
      }
    }
  });
});
