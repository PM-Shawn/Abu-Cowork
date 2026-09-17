import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bootstrapSecrets, reconcileActiveProvider, useSettingsStore } from './settingsStore';
import type { ManagedProviderInput, ProviderInstance } from '../types/provider';

const personalProvider: ProviderInstance = {
  id: 'deepseek',
  source: 'builtin',
  name: 'DeepSeek',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: '',
  apiKey: 'sk-personal',
  models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
  status: 'unchecked',
  sortOrder: 1,
};

const gatewayInput: ManagedProviderInput = {
  id: 'enterprise-gateway',
  name: 'MAZG',
  baseUrl: 'https://abu-op.example.net/api/gateway',
  apiKey: 'sk-virtual-test',
  models: [{ id: 'deepseek-v3', label: 'deepseek-v3' }],
};

describe('managed providers', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
    });
  });

  describe('upsertManagedProvider', () => {
    it('插入一条 source 为 managed 的记录，并排在列表最前', () => {
      useSettingsStore.setState({
        providers: [{
          id: 'deepseek',
          source: 'builtin',
          name: 'DeepSeek',
          enabled: true,
          apiFormat: 'openai-compatible',
          baseUrl: '',
          apiKey: 'sk-personal',
          models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
          status: 'unchecked',
          sortOrder: 1,
        }],
      });

      useSettingsStore.getState().upsertManagedProvider(gatewayInput);

      const providers = useSettingsStore.getState().providers;
      expect(providers[0].id).toBe('enterprise-gateway');
      expect(providers[0].source).toBe('managed');
      expect(providers[0].enabled).toBe(true);
      expect(providers[0].apiFormat).toBe('openai-compatible');
      expect(providers[0].models.map(m => m.id)).toEqual(['deepseek-v3']);
    });

    it('个人 provider 一条都不会被改动', () => {
      useSettingsStore.setState({
        providers: [{
          id: 'deepseek',
          source: 'builtin',
          name: 'DeepSeek',
          enabled: true,
          apiFormat: 'openai-compatible',
          baseUrl: '',
          apiKey: 'sk-personal',
          models: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
          status: 'unchecked',
          sortOrder: 1,
        }],
      });

      useSettingsStore.getState().upsertManagedProvider(gatewayInput);

      const personal = useSettingsStore.getState().providers.find(p => p.id === 'deepseek');
      expect(personal?.apiKey).toBe('sk-personal');
      expect(personal?.enabled).toBe(true);
      expect(personal?.models.map(m => m.id)).toEqual(['deepseek-chat']);
    });

    it('重复调用是覆盖而不是新增，凭据与模型都跟着更新', () => {
      const store = useSettingsStore.getState();
      store.upsertManagedProvider(gatewayInput);
      store.upsertManagedProvider({
        ...gatewayInput,
        apiKey: 'sk-rotated',
        models: [{ id: 'qwen-max', label: 'qwen-max' }],
      });

      const matched = useSettingsStore.getState().providers.filter(p => p.id === 'enterprise-gateway');
      expect(matched).toHaveLength(1);
      expect(matched[0].apiKey).toBe('sk-rotated');
      expect(matched[0].models.map(m => m.id)).toEqual(['qwen-max']);
    });
  });

  describe('持久化隔离', () => {
    // 托管条目的凭据属于注册它的外部系统。localStorage 或密钥库里多出一份副本，
    // 凭据更换后它就是过期的，退出后它就是仍然可用的凭据。
    const invokeMock = vi.mocked(invoke);

    function persistedProviders(): Array<{ id: string }> {
      const options = (useSettingsStore as unknown as {
        persist: { getOptions: () => { partialize: (state: unknown) => { providers: Array<{ id: string }> } } };
      }).persist.getOptions();
      return options.partialize(useSettingsStore.getState()).providers;
    }

    /** 每次带 key 的密钥库调用：[命令, key]。 */
    function secretCalls(): Array<[string, string]> {
      return invokeMock.mock.calls.flatMap(([cmd, args]): Array<[string, string]> => {
        const key = (args as { key?: string } | undefined)?.key;
        return typeof key === 'string' ? [[cmd as string, key]] : [];
      });
    }

    beforeEach(() => {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(null);
      useSettingsStore.setState({
        providers: [personalProvider],
        auxiliaryServices: {},
        imageGeneration: { backends: [] },
      });
      useSettingsStore.getState().upsertManagedProvider(gatewayInput);
    });

    it('持久化快照只含个人 provider', () => {
      expect(persistedProviders().map(p => p.id)).toEqual(['deepseek']);
    });

    it('启动时的密钥读取与回填都不碰托管条目', async () => {
      await bootstrapSecrets();

      const touched = secretCalls().map(([, key]) => key);
      expect(touched).toContain('provider:deepseek');
      expect(touched).not.toContain('provider:enterprise-gateway');
    });

    it('清除全部密钥不会删除或清空托管条目的凭据', async () => {
      await useSettingsStore.getState().clearAllStoredKeys();

      expect(secretCalls()).not.toContainEqual(['secret_delete', 'provider:enterprise-gateway']);
      const providers = useSettingsStore.getState().providers;
      expect(providers.find(p => p.id === 'enterprise-gateway')?.apiKey).toBe('sk-virtual-test');
      expect(providers.find(p => p.id === 'deepseek')?.apiKey).toBe('');
    });
  });

  describe('重启后的选择', () => {
    // rehydrate 是同步的，托管条目由外部系统稍后注册。这段时间里“找不到
    // provider”只说明它还没注册。
    const missing = (): { providers: ProviderInstance[]; activeModel: { providerId: string; modelId: string } } => ({
      providers: [{ ...personalProvider }],
      activeModel: { providerId: 'enterprise-gateway', modelId: 'deepseek-v3' },
    });

    it('托管条目注册之前保留选择', () => {
      const state = missing();
      reconcileActiveProvider(state, { managedProvidersReady: false });

      expect(state.activeModel).toEqual({ providerId: 'enterprise-gateway', modelId: 'deepseek-v3' });
    });

    it('注册时机过后仍然找不到，换成可用的个人 provider', () => {
      const state = missing();
      reconcileActiveProvider(state, { managedProvidersReady: true });

      expect(state.activeModel).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' });
    });

    it('markManagedProvidersReady 保留已注册的托管选择', () => {
      useSettingsStore.setState({
        providers: [personalProvider],
        activeModel: { providerId: 'enterprise-gateway', modelId: 'deepseek-v3' },
      });
      useSettingsStore.getState().upsertManagedProvider(gatewayInput);

      useSettingsStore.getState().markManagedProvidersReady();

      expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'enterprise-gateway', modelId: 'deepseek-v3' });
    });

    it('markManagedProvidersReady 在托管条目不存在时换成个人 provider', () => {
      useSettingsStore.setState({
        providers: [personalProvider],
        activeModel: { providerId: 'enterprise-gateway', modelId: 'deepseek-v3' },
      });

      useSettingsStore.getState().markManagedProvidersReady();

      expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' });
    });
  });

  describe('removeManagedProvider', () => {
    it('移除该条记录', () => {
      const store = useSettingsStore.getState();
      store.upsertManagedProvider(gatewayInput);
      store.removeManagedProvider('enterprise-gateway');

      expect(useSettingsStore.getState().providers.find(p => p.id === 'enterprise-gateway')).toBeUndefined();
    });

    it('同名的个人 provider 不会被误删', () => {
      useSettingsStore.setState({
        providers: [{
          id: 'enterprise-gateway',
          source: 'custom',
          name: '用户自建的同名条目',
          enabled: true,
          apiFormat: 'openai-compatible',
          baseUrl: 'https://self-hosted.example',
          apiKey: 'sk-own',
          models: [],
          status: 'unchecked',
          sortOrder: 1,
        }],
      });

      useSettingsStore.getState().removeManagedProvider('enterprise-gateway');

      expect(useSettingsStore.getState().providers.find(p => p.id === 'enterprise-gateway')?.source).toBe('custom');
    });
  });
});
