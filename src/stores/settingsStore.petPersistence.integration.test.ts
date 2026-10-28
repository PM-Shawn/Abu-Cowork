// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPermissionConfig } from '@/core/permissions/browserPermissionConfig';
import { INITIAL_BROWSER_CONFIG_REVISIONS } from './browserConfigPersistence';
import type * as SettingsModule from './settingsStore';

const SETTINGS_KEY = 'abu-settings';
const MODEL_A = { providerId: 'ollama', modelId: 'llama3.2:latest' };
const MODEL_B = { providerId: 'deepseek', modelId: 'deepseek-flash' };
const originalUrl = window.location.href;
let main: typeof SettingsModule;
let queue: Promise<unknown>;
let addEventListener: ReturnType<typeof vi.spyOn<typeof window, 'addEventListener'>>;

function removeStorageListeners(): void {
  for (const [type, listener, options] of addEventListener.mock.calls) {
    if (type === 'storage') window.removeEventListener(type, listener, options);
  }
}

async function loadWindow(path: string): Promise<typeof SettingsModule> {
  window.history.replaceState(null, '', path);
  vi.resetModules();
  return import('./settingsStore');
}

function storedSettings() {
  return JSON.parse(localStorage.getItem(SETTINGS_KEY)!);
}

function deliverStorageEvent(): void {
  window.dispatchEvent(new StorageEvent('storage', {
    key: SETTINGS_KEY,
    newValue: localStorage.getItem(SETTINGS_KEY),
  }));
}

beforeAll(async () => {
  addEventListener = vi.spyOn(window, 'addEventListener');
  await loadWindow('/index.html');
  removeStorageListeners();
  addEventListener.mockRestore();
});

beforeEach(async () => {
  queue = Promise.resolve();
  vi.stubGlobal('navigator', {
    language: 'en-US',
    locks: {
      request: (_name: string, callback: () => unknown) => {
        const next = queue.then(callback);
        queue = next;
        return next;
      },
    },
  });
  addEventListener = vi.spyOn(window, 'addEventListener');
  main = await loadWindow('/index.html');
  main.useSettingsStore.setState({
    activeModel: MODEL_A,
    recentModels: [MODEL_A],
    browserPermissionConfigV2: createBrowserPermissionConfig(),
    browserConfigRevisions: { ...INITIAL_BROWSER_CONFIG_REVISIONS },
  });
  await queue;
});

afterEach(async () => {
  await queue;
  removeStorageListeners();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', originalUrl);
});

describe('pet settings persistence', () => {
  it('receives newer permissions while retaining the main window model and provider settings on disk', async () => {
    const pet = await loadWindow('/pet.html');
    expect(pet.useSettingsStore.getState().activeModel).toEqual(MODEL_A);

    main.useSettingsStore.getState().selectModel(MODEL_B.providerId, MODEL_B.modelId);
    main.useSettingsStore.getState().updateProvider('deepseek', { name: 'My DeepSeek' });
    await queue;
    deliverStorageEvent();
    await queue;
    expect(storedSettings().state.activeModel).toEqual(MODEL_B);

    expect(await main.useSettingsStore.getState().setBrowserPermissionDefault('browse', 'deny')).toBe(true);
    await queue;
    const saved = localStorage.getItem(SETTINGS_KEY);
    deliverStorageEvent();
    await queue;

    expect(pet.useSettingsStore.getState().browserPermissionConfigV2.defaults.browse).toBe('deny');
    expect(pet.useSettingsStore.getState().browserConfigRevisions.browserPermissionConfigV2).toBe(1);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(saved);
    expect(storedSettings().state.activeModel).toEqual(MODEL_B);
    expect(storedSettings().state.recentModels[0]).toEqual(MODEL_B);
    expect(storedSettings().state.providers.find((provider: { id: string }) => provider.id === 'deepseek').name)
      .toBe('My DeepSeek');

    const reopenedMain = await loadWindow('/index.html');
    expect(reopenedMain.useSettingsStore.getState().activeModel).toEqual(MODEL_B);
  });

  it('keeps pet migration results in memory until the main window saves its own migration', async () => {
    const legacy = storedSettings();
    legacy.version = 53;
    legacy.state.theme = 'dark';
    const raw = JSON.stringify(legacy);
    localStorage.setItem(SETTINGS_KEY, raw);

    const pet = await loadWindow('/pet.html?source=desktop');
    await queue;
    expect(pet.useSettingsStore.getState().theme).toBe('system');
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(raw);

    const reopenedMain = await loadWindow('/index.html');
    await queue;
    expect(reopenedMain.useSettingsStore.getState().theme).toBe('system');
    expect(storedSettings().version).toBe(55);
    expect(storedSettings().state.theme).toBe('system');
    expect(storedSettings().state.activeModel).toEqual(MODEL_A);
  });

  it('keeps V55 vision migration read-only in the pet and preserves later user declarations on reopen', async () => {
    const legacy = storedSettings();
    legacy.version = 54;
    const provider = legacy.state.providers.find((entry: { id: string }) => entry.id === 'ollama');
    provider.enabled = true;
    provider.models = [
      { id: MODEL_A.modelId, label: 'Llama', declaredCapabilities: { supportsImages: true, supportsTools: true } },
      { id: MODEL_B.modelId, label: 'Flash', declaredCapabilities: { supportsImages: false, supportsTools: true } },
    ];
    const raw = JSON.stringify(legacy);
    localStorage.setItem(SETTINGS_KEY, raw);

    const pet = await loadWindow('/pet.html');
    await queue;
    expect(pet.useSettingsStore.getState().providers.find((entry) => entry.id === 'ollama')?.models
      .map((model) => model.declaredCapabilities?.supportsImages)).toEqual([false, true]);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(raw);

    const upgradedMain = await loadWindow('/index.html');
    await queue;
    expect(storedSettings().version).toBe(55);
    expect(storedSettings().state.providers.find((entry: { id: string }) => entry.id === 'ollama').models
      .map((model: { declaredCapabilities: { supportsImages: boolean } }) => model.declaredCapabilities.supportsImages))
      .toEqual([false, true]);

    upgradedMain.useSettingsStore.getState().setProviderModels('ollama', provider.models);
    await queue;
    const reopenedMain = await loadWindow('/index.html');
    expect(reopenedMain.useSettingsStore.getState().providers.find((entry) => entry.id === 'ollama')?.models
      .map((model) => model.declaredCapabilities?.supportsImages)).toEqual([true, false]);
  });

  it('keeps shared storage when the pet clears its persistence adapter', async () => {
    const pet = await loadWindow('/pet.html');
    const saved = localStorage.getItem(SETTINGS_KEY);
    await pet.useSettingsStore.persist.clearStorage();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(saved);

    await main.useSettingsStore.persist.clearStorage();
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it('retains model selection when the main window saves pet position and visibility', async () => {
    const pet = await loadWindow('/pet.html');
    main.useSettingsStore.getState().selectModel(MODEL_B.providerId, MODEL_B.modelId);
    main.useSettingsStore.getState().setPetPosition({ x: 120, y: 240 });
    main.useSettingsStore.getState().setPetOpen(false);
    await queue;

    expect(pet.useSettingsStore.getState().activeModel).toEqual(MODEL_A);
    expect(storedSettings().state.activeModel).toEqual(MODEL_B);
    expect(storedSettings().state.petPosition).toEqual({ x: 120, y: 240 });
    expect(storedSettings().state.petOpen).toBe(false);
  });
});
