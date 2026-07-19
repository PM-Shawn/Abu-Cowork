/**
 * Global test setup — mock all Tauri and external SDK modules
 */
import { vi, beforeEach, afterEach } from 'vitest';
// Extend expect with jest-dom matchers for React component tests
// (toBeInTheDocument / toBeDisabled / toHaveTextContent / etc.)
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

// ── @tauri-apps/api ──
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/Users/testuser'),
  appDataDir: vi.fn().mockResolvedValue('/Users/testuser/.abu'),
  resolve: vi.fn((...args: string[]) => Promise.resolve(args.join('/'))),
  join: vi.fn((...args: string[]) => Promise.resolve(args.join('/'))),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  transformCallback: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  emitTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    listen: vi.fn().mockResolvedValue(() => {}),
    emit: vi.fn(),
  })),
  Window: vi.fn(),
}));

// ── @tauri-apps plugins ──
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn().mockResolvedValue(''),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  exists: vi.fn().mockResolvedValue(false),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  watch: vi.fn().mockResolvedValue(() => {}),
  BaseDirectory: { AppData: 0, Home: 1 },
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn().mockResolvedValue('macos'),
  arch: vi.fn().mockResolvedValue('aarch64'),
  version: vi.fn().mockResolvedValue('14.0'),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    sidecar: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
  message: vi.fn().mockResolvedValue(undefined),
  ask: vi.fn().mockResolvedValue(false),
  confirm: vi.fn().mockResolvedValue(false),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  requestPermission: vi.fn().mockResolvedValue('granted'),
  isPermissionGranted: vi.fn().mockResolvedValue(true),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn().mockResolvedValue(''),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn().mockResolvedValue(null),
  onOpenUrl: vi.fn().mockResolvedValue(() => {}),
  register: vi.fn().mockResolvedValue(null),
  unregister: vi.fn().mockResolvedValue(null),
  isRegistered: vi.fn().mockResolvedValue(false),
}));

// ── External SDKs ──
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
      stream: vi.fn(),
    },
  })),
  Anthropic: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
      stream: vi.fn(),
    },
  })),
}));

vi.mock('@modelcontextprotocol/sdk', () => ({}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({}));

// ── Polyfill localStorage for happy-dom ──
// happy-dom may not fully implement the Storage API needed by Zustand persist
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  } as Storage;
}

// ── Reset localStorage before each test ──
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // Fallback: no-op
  }
});

// ── Cleanup React Testing Library renders after each test ──
afterEach(() => {
  cleanup();
});
