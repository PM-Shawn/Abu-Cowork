import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureConversationModelUsable } from './sendModelGuard';
import { subscribeModelPickerRequest } from './modelPickerRequest';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { getI18n, getLanguageSetting, setLanguage } from '@/i18n';
import type { ProviderInstance } from '@/types/provider';
import type { EnterpriseBinding } from '@/core/enterprise/types';

function provider(id: string, overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  const template = useSettingsStore.getInitialState().providers.find((p) => p.id === 'anthropic')!;
  return {
    ...template,
    id,
    name: id,
    enabled: true,
    apiKey: 'test-key',
    userAdded: true,
    models: [{ ...template.models[0], id: 'model-a', label: '' }],
    ...overrides,
  };
}

function setProviders(providers: ProviderInstance[]): void {
  useSettingsStore.setState({ providers });
}

function withZhCN(run: () => void): void {
  const previousLanguage = getLanguageSetting();
  setLanguage('zh-CN');
  try {
    run();
  } finally {
    setLanguage(previousLanguage);
  }
}

describe('ensureConversationModelUsable', () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    useToastStore.setState(useToastStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' } });
  });

  it('lets a usable pin through without a toast or opening settings', () => {
    setProviders([provider('prov-a')]);
    const ok = ensureConversationModelUsable({ model: { providerId: 'prov-a', modelId: 'model-a' } }, getI18n().chat);
    expect(ok).toBe(true);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
  });

  it('blocks a removed provider with a toast naming the model when another provider is usable', () => {
    withZhCN(() => {
      setProviders([provider('prov-b')]);
      const ok = ensureConversationModelUsable({ model: { providerId: 'gone-provider', modelId: 'model-a' } }, getI18n().chat);
      expect(ok).toBe(false);
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        type: 'error',
        title: '模型「model-a」所属服务已删除，请换一个模型再发送',
      });
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    });
  });

  it('blocks a turned-off provider with a toast when another provider is usable', () => {
    withZhCN(() => {
      setProviders([provider('prov-a', { enabled: false }), provider('prov-b')]);
      const ok = ensureConversationModelUsable({ model: { providerId: 'prov-a', modelId: 'model-a' } }, getI18n().chat);
      expect(ok).toBe(false);
      expect(useToastStore.getState().toasts.at(-1)?.title).toContain('所属服务已关闭');
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    });
  });

  it('opens settings instead of toasting when no provider is usable at all', () => {
    setProviders([provider('prov-a', { enabled: false })]);
    const ok = ensureConversationModelUsable({ model: { providerId: 'gone-provider', modelId: 'model-a' } }, getI18n().chat);
    expect(ok).toBe(false);
    expect(useSettingsStore.getState()).toMatchObject({ systemSettingsOpen: true, activeSystemTab: 'ai-services' });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('lets a managed provider through while its model list is still being pulled', () => {
    setProviders([
      provider('org-models', { source: 'managed', userAdded: false, status: 'checking', models: [] }),
      provider('prov-b'),
    ]);
    const ok = ensureConversationModelUsable({ model: { providerId: 'org-models', modelId: 'org-model' } }, getI18n().chat);
    expect(ok).toBe(true);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('blocks a model the managed provider confirmed it no longer offers and opens the picker', () => {
    const pickerRequests = vi.fn();
    const stop = subscribeModelPickerRequest(pickerRequests);
    try {
      withZhCN(() => {
        setProviders([
          provider('org-models', { source: 'managed', userAdded: false, status: 'verified' }),
          provider('prov-b'),
        ]);
        const ok = ensureConversationModelUsable({ model: { providerId: 'org-models', modelId: 'revoked' } }, getI18n().chat);
        expect(ok).toBe(false);
        expect(useToastStore.getState().toasts.at(-1)?.title).toBe('模型「revoked」已不可用，请重新选择');
        expect(pickerRequests).toHaveBeenCalledTimes(1);
        expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
      });
    } finally {
      stop();
    }
  });

  it('keeps the picker closed when the user\'s own provider dropped the model', () => {
    const pickerRequests = vi.fn();
    const stop = subscribeModelPickerRequest(pickerRequests);
    try {
      setProviders([provider('prov-a'), provider('prov-b')]);
      expect(ensureConversationModelUsable({ model: { providerId: 'prov-a', modelId: 'gone' } }, getI18n().chat)).toBe(false);
      expect(pickerRequests).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('applies the same check whatever account the user is signed in to', () => {
    useEnterpriseStore.setState({
      mode: { kind: 'enterprise', binding: {} as EnterpriseBinding, config: null },
    });
    setProviders([provider('prov-b')]);
    const ok = ensureConversationModelUsable({ model: { providerId: 'gone-provider', modelId: 'model-a' } }, getI18n().chat);
    expect(ok).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('checks the global model when there is no conversation', () => {
    setProviders([provider('prov-a'), provider('prov-b')]);
    useSettingsStore.setState({ activeModel: { providerId: 'prov-a', modelId: 'model-a' } });
    expect(ensureConversationModelUsable(undefined, getI18n().chat)).toBe(true);
    expect(useToastStore.getState().toasts).toEqual([]);

    useSettingsStore.setState({ activeModel: { providerId: 'gone-provider', modelId: 'model-a' } });
    expect(ensureConversationModelUsable(undefined, getI18n().chat)).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
