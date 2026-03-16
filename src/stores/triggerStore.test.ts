/**
 * triggerStore tests — v2→v3 migration + CRUD basics
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock imChannelStore before importing triggerStore
const mockChannels: Record<string, { id: string; platform: string; appId: string; appSecret: string; name: string }> = {};
let addChannelCounter = 0;

vi.mock('./imChannelStore', () => ({
  useIMChannelStore: {
    getState: () => ({
      channels: mockChannels,
      addChannel: (data: { platform: string; name: string; appId: string; appSecret: string }) => {
        addChannelCounter++;
        const id = `migrated-ch-${addChannelCounter}`;
        mockChannels[id] = { id, ...data };
        return id;
      },
    }),
  },
}));

import { useTriggerStore } from './triggerStore';

describe('triggerStore', () => {
  beforeEach(() => {
    // Reset store
    useTriggerStore.setState({
      triggers: {},
      selectedTriggerId: null,
      showEditor: false,
      editingTriggerId: null,
      editorTemplateDefaults: null,
    });
    // Reset mock channels
    for (const key of Object.keys(mockChannels)) delete mockChannels[key];
    addChannelCounter = 0;
  });

  describe('CRUD', () => {
    it('creates a trigger with IM source referencing channelId', () => {
      const store = useTriggerStore.getState();
      const id = store.createTrigger({
        name: 'IM Alert',
        source: {
          type: 'im',
          channelId: 'ch-1',
          listenScope: 'all',
        },
        filter: { type: 'always' },
        action: { prompt: 'handle $EVENT_DATA' },
        debounce: { enabled: true, windowSeconds: 300 },
      });

      const trigger = useTriggerStore.getState().triggers[id];
      expect(trigger).toBeDefined();
      expect(trigger.source.type).toBe('im');
      if (trigger.source.type === 'im') {
        expect(trigger.source.channelId).toBe('ch-1');
        expect(trigger.source.listenScope).toBe('all');
        // Old fields should not exist
        expect('platform' in trigger.source).toBe(false);
        expect('appId' in trigger.source).toBe(false);
      }
    });

    it('creates a trigger with im_channel output', () => {
      const store = useTriggerStore.getState();
      const id = store.createTrigger({
        name: 'Alert with output',
        source: { type: 'http' },
        filter: { type: 'always' },
        action: { prompt: 'analyze' },
        debounce: { enabled: false, windowSeconds: 0 },
        output: {
          enabled: true,
          target: 'im_channel',
          outputChannelId: 'ch-out',
          outputChatId: 'oc_xxx',
          extractMode: 'last_message',
        },
      });

      const trigger = useTriggerStore.getState().triggers[id];
      expect(trigger.output?.target).toBe('im_channel');
      expect(trigger.output?.outputChannelId).toBe('ch-out');
      expect(trigger.output?.outputChatId).toBe('oc_xxx');
    });

    it('creates a trigger with chatId and senderMatch filters', () => {
      const store = useTriggerStore.getState();
      const id = store.createTrigger({
        name: 'Filtered IM',
        source: {
          type: 'im',
          channelId: 'ch-2',
          listenScope: 'mention_only',
          chatId: 'oc_abc',
          senderMatch: '告警机器人',
        },
        filter: { type: 'regex', pattern: '告警|ERROR' },
        action: { prompt: 'handle alert' },
        debounce: { enabled: true, windowSeconds: 60 },
      });

      const trigger = useTriggerStore.getState().triggers[id];
      if (trigger.source.type === 'im') {
        expect(trigger.source.chatId).toBe('oc_abc');
        expect(trigger.source.senderMatch).toBe('告警机器人');
      }
    });
  });

  describe('v2→v3 migration', () => {
    // We test the migration logic by calling it directly via persist's migrate function.
    // Since Zustand persist exposes the migrate fn internally, we simulate it
    // by constructing v2-format data and running the migrate path.

    it('migrates IM source: replaces platform/appId/appSecret with channelId (existing channel)', () => {
      // Pre-seed a matching channel
      mockChannels['existing-ch'] = {
        id: 'existing-ch',
        platform: 'feishu',
        appId: 'cli_abc',
        appSecret: 'secret',
        name: '飞书机器人',
      };

      // Simulate v2 persisted data
      const v2Data = {
        triggers: {
          't1': {
            id: 't1',
            name: 'Old IM Trigger',
            status: 'active',
            source: {
              type: 'im',
              platform: 'feishu',
              appId: 'cli_abc',
              appSecret: 'secret',
              listenScope: 'all',
            },
            filter: { type: 'always' },
            action: { prompt: 'test' },
            debounce: { enabled: false, windowSeconds: 0 },
            runs: [],
            totalRuns: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };

      // Run the store's persist.migrate by loading v2 data into localStorage
      // and re-creating the store. Instead, let's directly call the migrate logic.
      // We extract the migrate function by accessing the persist API.
      const persistApi = (useTriggerStore as unknown as { persist: { getOptions: () => { migrate: (data: unknown, version: number) => unknown } } }).persist;
      const { migrate } = persistApi.getOptions();

      const migrated = migrate(v2Data, 2) as typeof v2Data;

      const source = migrated.triggers['t1'].source as Record<string, unknown>;
      expect(source.channelId).toBe('existing-ch');
      expect(source.platform).toBeUndefined();
      expect(source.appId).toBeUndefined();
      expect(source.appSecret).toBeUndefined();
      expect(source.listenScope).toBe('all');
    });

    it('migrates IM source: creates new channel when no match found', () => {
      // No pre-seeded channels

      const v2Data = {
        triggers: {
          't2': {
            id: 't2',
            name: 'Dingtalk Trigger',
            status: 'active',
            source: {
              type: 'im',
              platform: 'dingtalk',
              appId: 'dt_app_123',
              appSecret: 'dt_secret',
              listenScope: 'mention_only',
            },
            filter: { type: 'keyword', keywords: ['告警'] },
            action: { prompt: 'handle alert' },
            debounce: { enabled: true, windowSeconds: 300 },
            runs: [],
            totalRuns: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };

      const persistApi = (useTriggerStore as unknown as { persist: { getOptions: () => { migrate: (data: unknown, version: number) => unknown } } }).persist;
      const { migrate } = persistApi.getOptions();

      const migrated = migrate(v2Data, 2) as typeof v2Data;

      const source = migrated.triggers['t2'].source as Record<string, unknown>;
      // Should have created a new channel
      expect(addChannelCounter).toBe(1);
      expect(source.channelId).toBe('migrated-ch-1');
      expect(source.platform).toBeUndefined();
      expect(source.appId).toBeUndefined();

      // Verify the created channel has correct data
      expect(mockChannels['migrated-ch-1'].platform).toBe('dingtalk');
      expect(mockChannels['migrated-ch-1'].appId).toBe('dt_app_123');
      expect(mockChannels['migrated-ch-1'].name).toBe('dingtalk (migrated)');
    });

    it('migrates output target: reply_source → im_channel', () => {
      mockChannels['ch-fs'] = {
        id: 'ch-fs',
        platform: 'feishu',
        appId: 'cli_x',
        appSecret: 's',
        name: 'feishu bot',
      };

      const v2Data = {
        triggers: {
          't3': {
            id: 't3',
            name: 'Reply Trigger',
            status: 'active',
            source: {
              type: 'im',
              platform: 'feishu',
              appId: 'cli_x',
              appSecret: 's',
              listenScope: 'all',
            },
            filter: { type: 'always' },
            action: { prompt: 'reply' },
            debounce: { enabled: false, windowSeconds: 0 },
            output: {
              enabled: true,
              target: 'reply_source',
              extractMode: 'last_message',
            },
            runs: [],
            totalRuns: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };

      const persistApi = (useTriggerStore as unknown as { persist: { getOptions: () => { migrate: (data: unknown, version: number) => unknown } } }).persist;
      const { migrate } = persistApi.getOptions();

      const migrated = migrate(v2Data, 2) as typeof v2Data;

      const output = migrated.triggers['t3'].output as Record<string, unknown>;
      expect(output.target).toBe('im_channel');
      expect(output.outputChannelId).toBe('ch-fs');
    });

    it('does not modify non-IM triggers during migration', () => {
      const v2Data = {
        triggers: {
          'http-t': {
            id: 'http-t',
            name: 'HTTP Trigger',
            status: 'active',
            source: { type: 'http' },
            filter: { type: 'always' },
            action: { prompt: 'go' },
            debounce: { enabled: false, windowSeconds: 0 },
            output: {
              enabled: true,
              target: 'webhook',
              platform: 'dchat',
              webhookUrl: 'https://example.com/hook',
              extractMode: 'last_message',
            },
            runs: [],
            totalRuns: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      };

      const persistApi = (useTriggerStore as unknown as { persist: { getOptions: () => { migrate: (data: unknown, version: number) => unknown } } }).persist;
      const { migrate } = persistApi.getOptions();

      const migrated = migrate(v2Data, 2) as typeof v2Data;

      const source = migrated.triggers['http-t'].source as Record<string, unknown>;
      expect(source.type).toBe('http');
      const output = migrated.triggers['http-t'].output as Record<string, unknown>;
      expect(output.target).toBe('webhook');
      expect(output.platform).toBe('dchat');
    });

    it('skips migration for version >= 3', () => {
      const v3Data = {
        triggers: {
          't': {
            id: 't',
            source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
            output: { enabled: true, target: 'im_channel', outputChannelId: 'ch-1' },
          },
        },
      };

      const persistApi = (useTriggerStore as unknown as { persist: { getOptions: () => { migrate: (data: unknown, version: number) => unknown } } }).persist;
      const { migrate } = persistApi.getOptions();

      const migrated = migrate(v3Data, 3) as typeof v3Data;

      // Should be unchanged
      const source = migrated.triggers['t'].source as Record<string, unknown>;
      expect(source.channelId).toBe('ch-1');
    });
  });
});
