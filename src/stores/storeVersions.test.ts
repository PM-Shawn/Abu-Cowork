// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { locks } from 'node:worker_threads';

// All persisted stores must be registered here.
// When adding a new persist store, add it to this list — otherwise this test fails.
const PERSISTED_STORES = [
  { key: 'abu-settings', minVersion: 55 },
  { key: 'abu-chat', minVersion: 17 },
  { key: 'abu-app', minVersion: 1 },
  { key: 'abu-app-drafts', minVersion: 2 },
  { key: 'abu-scratchpad-store', minVersion: 1 },
  { key: 'abu-permissions', minVersion: 1 },
  { key: 'abu-workspace', minVersion: 1 },
  { key: 'abu-mcp-store', minVersion: 1 },
  { key: 'abu-schedule', minVersion: 6 },
  { key: 'abu-triggers', minVersion: 4 },
  { key: 'abu-im-channel', minVersion: 2 },
  { key: 'abu-projects', minVersion: 1 },
  { key: 'abu-project-hint', minVersion: 1 },
  { key: 'abu-diagnostic-store', minVersion: 3 },
  { key: 'abu-usage-stats', minVersion: 2 },
  { key: 'abu-discovered-caps', minVersion: 2 },
  { key: 'abu-todos', minVersion: 1 },
  { key: 'abu-inbox', minVersion: 2 },
  { key: 'abu-composer-drafts', minVersion: 2 },
  { key: 'abu-team', minVersion: 8 },
  { key: 'abu-team-confirmations', minVersion: 1 },
  { key: 'abu-plugins', minVersion: 3 },
  { key: 'abu-extension-source', minVersion: 1 },
  { key: 'abu-voice-input', minVersion: 1 },
  { key: 'abu-render-memory', minVersion: 1 },
] as const;

interface PersistedStore {
  getState(): Record<string, unknown>;
  setState(state: Record<string, unknown>): unknown;
  persist: {
    getOptions(): { name: string; version?: number };
    setOptions(options: { version?: number }): void;
  };
}

const stores = new Map<string, PersistedStore>();
const initialData = new Map<string, string>();

beforeAll(async () => {
  // Use the real Web Locks implementation for settings' serialized writes.
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  const seen = new Set<unknown>();
  for (const load of Object.values(import.meta.glob('./*Store.ts'))) {
    const module = await load() as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (typeof value !== 'function' || !('persist' in value) || seen.has(value)) continue;
      seen.add(value);
      const store = value as unknown as PersistedStore;
      const { name } = store.persist.getOptions();
      expect(stores.has(name), `duplicate persisted store name: ${name}`).toBe(false);
      stores.set(name, store);
    }
  }
  for (const [key, store] of stores) {
    await store.setState({ ...store.getState() });
    const raw = localStorage.getItem(key);
    expect(raw, `${key} must initialize persisted data`).not.toBeNull();
    initialData.set(key, raw!);
  }
}, 120_000); // Cold store imports include the full graph under coverage instrumentation.

beforeEach(async () => {
  for (const [key, raw] of initialData) localStorage.setItem(key, raw);
  for (const store of stores.values()) await store.setState({ ...store.getState() });
});

function assertPersistedVersion(key: string, minVersion: number) {
  const raw = localStorage.getItem(key);
  expect(raw, `${key} must write persisted data`).not.toBeNull();
  expect(JSON.parse(raw!).version, `${key} missing or outdated version`).toBeGreaterThanOrEqual(minVersion);
}

describe('Store version compliance', () => {
  it('all persisted stores should have version in their stored data', () => {
    for (const { key, minVersion } of PERSISTED_STORES) {
      expect(stores.get(key)?.persist.getOptions().version, `${key} configured version`).toBeGreaterThanOrEqual(minVersion);
      assertPersistedVersion(key, minVersion);
    }
  });

  it('registry should cover all abu-* keys in localStorage', () => {
    const registeredKeys = new Set<string>(PERSISTED_STORES.map((s) => s.key));
    expect(new Set(stores.keys())).toEqual(registeredKeys);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('abu-')) {
        expect(registeredKeys.has(key), `localStorage key "${key}" not registered in PERSISTED_STORES`).toBe(true);
      }
    }
  });

  it.each(PERSISTED_STORES)('rejects a real persisted version regression for $key', async ({ key, minVersion }) => {
    const store = stores.get(key)!;
    const { version } = store.persist.getOptions();
    try {
      store.persist.setOptions({ version: minVersion - 1 });
      await store.setState({ ...store.getState() });
      expect(JSON.parse(localStorage.getItem(key)!).version).toBe(minVersion - 1);
      expect(() => assertPersistedVersion(key, minVersion)).toThrow();
    } finally {
      store.persist.setOptions({ version });
      await store.setState({ ...store.getState() });
    }
  });

  it('rejects missing persisted data', () => {
    localStorage.removeItem('abu-settings');
    expect(() => assertPersistedVersion('abu-settings', 55)).toThrow();
  });
});
