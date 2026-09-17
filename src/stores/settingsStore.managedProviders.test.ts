import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './settingsStore';
import type { ManagedProviderInput } from '../types/provider';

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
