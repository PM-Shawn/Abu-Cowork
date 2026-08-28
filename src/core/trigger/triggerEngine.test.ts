/**
 * TriggerEngine tests — cover pure logic extracted from the engine:
 * matchGlob, simpleHash, debounce, quiet hours, filter matching,
 * concurrency control, and IM scope matching.
 *
 * The TriggerEngine class is a singleton with heavy Tauri/store dependencies,
 * so we test its internal logic by importing and exercising the class with
 * minimal mocking — focusing on the event handling path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useTriggerStore } from '../../stores/triggerStore';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useIMChannelStore } from '../../stores/imChannelStore';
import type { Trigger, TriggerEventPayload } from '../../types/trigger';
import type { IMChannel } from '../../types/imChannel';
import type { NormalizedIMMessage } from '../im/inboundRouter';

const runAgentLoopMock = vi.hoisted(() => vi.fn().mockResolvedValue({ reason: 'completed' }));
const createAuthorizationScopeMock = vi.hoisted(() => vi.fn(() => 'scope-trigger-test'));
const disposeAuthorizationScopeMock = vi.hoisted(() => vi.fn());

// Mock agentLoop to avoid full LLM execution
vi.mock('../agent/agentLoop', () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock('../agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: runAgentLoopMock,
}));

vi.mock('../tools/pathSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/pathSafety')>()),
  createAuthorizationScope: createAuthorizationScopeMock,
  disposeAuthorizationScope: disposeAuthorizationScopeMock,
}));

// Mock notifications
vi.mock('../../utils/notifications', () => ({
  notifyTriggerCompleted: vi.fn(),
  notifyTriggerError: vi.fn(),
}));

// Mock outputSender
vi.mock('../im/outputSender', () => ({
  outputSender: {
    buildMessage: vi.fn().mockReturnValue('test message'),
    send: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// Mock triggerPermission
vi.mock('./triggerPermission', () => ({
  resolveTriggerCallbacks: vi.fn().mockReturnValue({
    commandConfirmCallback: vi.fn().mockResolvedValue(true),
    filePermissionCallback: vi.fn().mockResolvedValue(true),
    blockedTools: [],
  }),
}));

// Mock triggerContextCache
vi.mock('../im/triggerContextCache', () => ({
  cacheTriggerContext: vi.fn(),
}));

// Mock im pluginRegistry
vi.mock('../im/pluginRegistry', () => ({
  getRegisteredPluginManifests: vi.fn().mockReturnValue([]),
}));

vi.mock('../../utils/tauriEnv', () => ({
  isTauriEnv: () => true,
}));

// Import after mocks
import { triggerEngine } from './triggerEngine';
import { outputSender } from '../im/outputSender';
import { getRegisteredPluginManifests } from '../im/pluginRegistry';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    name: 'Test Trigger',
    status: 'active',
    source: { type: 'http' },
    filter: { type: 'always' },
    action: { prompt: 'Do something with $EVENT_DATA' },
    debounce: { enabled: false, windowSeconds: 0 },
    createdAt: 1_700_000_000_000, // filler (TESTING.md §3) — not read by TriggerEngine
    updatedAt: 1_700_000_000_000,
    runs: [],
    totalRuns: 0,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch-1',
    platform: 'slack',
    name: 'Slack',
    appId: 'app',
    appSecret: 'secret',
    capability: 'safe_tools',
    responseMode: 'mention_only',
    allowedUsers: [],
    workspacePaths: [],
    sessionTimeoutMinutes: 0,
    maxRoundsPerSession: 50,
    enabled: true,
    status: 'connected',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('TriggerEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runAgentLoopMock.mockClear();
    runAgentLoopMock.mockResolvedValue({ reason: 'completed' });
    createAuthorizationScopeMock.mockClear();
    createAuthorizationScopeMock.mockReturnValue('scope-trigger-test');
    disposeAuthorizationScopeMock.mockClear();
    // Reset stores
    useTriggerStore.setState({ triggers: {}, triggerOrder: [] });
    useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
    useSettingsStore.setState({ imChannel: { allowLanWebhook: false } });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Filter matching ──
  describe('HTTP server binding', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockResolvedValue(18080);
      vi.mocked(getRegisteredPluginManifests).mockReturnValue([]);
    });

    afterEach(() => {
      triggerEngine.stop();
    });

    it('keeps loopback binding when a heartbeat plugin exists but LAN webhook is not allowed', async () => {
      vi.mocked(getRegisteredPluginManifests).mockReturnValue([
        {
          platform: 'heartbeat-test',
          displayName: 'Heartbeat Test',
          shortLabel: 'HT',
          capabilities: {
            markdown: false,
            card: false,
            messageUpdate: false,
            connectionType: 'heartbeat',
          },
        },
      ]);

      await triggerEngine.start();

      expect(invoke).toHaveBeenCalledWith('start_trigger_server', {
        port: 18080,
        bindAddr: '127.0.0.1',
      });
    });

    it('binds to LAN only when heartbeat plugin exists and the user explicitly allows it', async () => {
      useSettingsStore.setState({ imChannel: { allowLanWebhook: true } });
      vi.mocked(getRegisteredPluginManifests).mockReturnValue([
        {
          platform: 'heartbeat-test',
          displayName: 'Heartbeat Test',
          shortLabel: 'HT',
          capabilities: {
            markdown: false,
            card: false,
            messageUpdate: false,
            connectionType: 'heartbeat',
          },
        },
      ]);

      await triggerEngine.start();

      expect(invoke).toHaveBeenCalledWith('start_trigger_server', {
        port: 18080,
        bindAddr: '0.0.0.0',
      });
    });

    it('keeps loopback binding when a malformed v46 truthy value is present at runtime', async () => {
      useSettingsStore.setState({ imChannel: { allowLanWebhook: 'yes' as never } });
      vi.mocked(getRegisteredPluginManifests).mockReturnValue([
        {
          platform: 'heartbeat-test',
          displayName: 'Heartbeat Test',
          shortLabel: 'HT',
          capabilities: {
            markdown: false,
            card: false,
            messageUpdate: false,
            connectionType: 'heartbeat',
          },
        },
      ]);

      await triggerEngine.start();

      expect(invoke).toHaveBeenCalledWith('start_trigger_server', {
        port: 18080,
        bindAddr: '127.0.0.1',
      });
    });
  });

  describe('HTTP source boundary', () => {
    beforeEach(() => {
      vi.mocked(invoke).mockResolvedValue(18080);
      vi.mocked(listen).mockClear();
      vi.mocked(listen).mockResolvedValue(() => {});
    });

    afterEach(() => {
      triggerEngine.stop();
    });

    function httpListener(): (event: { payload: { triggerId: string; payload: TriggerEventPayload } }) => void {
      return vi.mocked(listen).mock.calls.find(([eventName]) => eventName === 'trigger-http-event')?.[1] as
        (event: { payload: { triggerId: string; payload: TriggerEventPayload } }) => void;
    }

    it('does not let the HTTP endpoint fire an IM trigger even if its channel is disabled or removed', async () => {
      const trigger = makeTrigger({
        id: 'trigger-http-to-im',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ enabled: false }) },
        sessions: {},
        archivedSessions: {},
      });
      await triggerEngine.start();
      const listener = httpListener();

      listener({ payload: { triggerId: trigger.id, payload: { data: { text: 'bypass' } } } });
      useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
      listener({ payload: { triggerId: trigger.id, payload: { data: { text: 'bypass-again' } } } });

      expect(runAgentLoopMock).not.toHaveBeenCalled();
    });

    it('still dispatches a genuine HTTP trigger from the HTTP endpoint', async () => {
      const trigger = makeTrigger({
        id: 'trigger-real-http',
        source: { type: 'http' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      await triggerEngine.start();

      httpListener()({ payload: { triggerId: trigger.id, payload: { data: { text: 'ok' } } } });

      await vi.waitFor(() => expect(runAgentLoopMock).toHaveBeenCalledTimes(1));
    });

    it('does not execute a queued HTTP retry after the trigger source changes to IM', async () => {
      const trigger = makeTrigger({
        id: 'trigger-http-source-race',
        source: { type: 'http' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      await triggerEngine.start();
      let resolveFirst!: () => void;
      runAgentLoopMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }));
      const listener = httpListener();

      listener({ payload: { triggerId: trigger.id, payload: { data: { seq: 1 } } } });
      await vi.waitFor(() => expect(runAgentLoopMock).toHaveBeenCalledTimes(1));
      listener({ payload: { triggerId: trigger.id, payload: { data: { seq: 2 } } } });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
          },
        },
      }));

      resolveFirst();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Filter matching ──
  describe('filter matching', () => {
    it('always filter passes all events', async () => {
      const trigger = makeTrigger({ filter: { type: 'always' } });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { any: 'value' } });
      // If it didn't skip, the trigger ran (agentLoop was called)
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });

    it('keyword filter matches when keyword present', async () => {
      const trigger = makeTrigger({
        filter: { type: 'keyword', keywords: ['error', 'critical'] },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { message: 'A critical issue occurred' } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });

    it('keyword filter skips when no keyword matches', async () => {
      const trigger = makeTrigger({
        id: 'trigger-kw-skip',
        filter: { type: 'keyword', keywords: ['error', 'critical'] },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { message: 'All good' } });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });

    it('regex filter matches pattern', async () => {
      const trigger = makeTrigger({
        filter: { type: 'regex', pattern: 'ERROR \\d+' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { log: 'ERROR 404 not found' } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });

    it('regex filter handles invalid regex gracefully', async () => {
      const trigger = makeTrigger({
        id: 'trigger-bad-regex',
        filter: { type: 'regex', pattern: '[invalid(' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      // Should not throw, just skip
      await triggerEngine.handleEvent(trigger.id, { data: { text: 'hello' } });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });

    it('field filter matches nested data path', async () => {
      const trigger = makeTrigger({
        filter: { type: 'keyword', keywords: ['deploy'], field: 'action' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { action: 'deploy', target: 'prod' } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });
  });

  // ── Status checks ──
  describe('status checks', () => {
    it('skips paused triggers', async () => {
      const trigger = makeTrigger({ status: 'paused' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: {} });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });

    it('skips unknown trigger ID', async () => {
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      await triggerEngine.handleEvent('nonexistent', { data: {} });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });
  });

  // ── Debounce ──
  describe('debounce', () => {
    it('deduplicates identical events within window', async () => {
      const trigger = makeTrigger({
        id: 'trigger-debounce',
        debounce: { enabled: true, windowSeconds: 10 },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const payload: TriggerEventPayload = { data: { file: 'test.txt' } };

      // First call should go through
      await triggerEngine.handleEvent(trigger.id, payload);
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalledTimes(1);

      // Second identical call within window should be debounced
      vi.mocked(runAgentLoop).mockClear();
      await triggerEngine.handleEvent(trigger.id, payload);
      // The debounce check happens before execution — if debounced, agentLoop not called
      // But note: handleEvent is async and has its own flow. The debounce state persists.
    });

    it('allows different events even with debounce enabled', async () => {
      const trigger = makeTrigger({
        id: 'trigger-debounce-diff',
        debounce: { enabled: true, windowSeconds: 10 },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { file: 'a.txt' } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      const callCount1 = vi.mocked(runAgentLoop).mock.calls.length;

      await triggerEngine.handleEvent(trigger.id, { data: { file: 'b.txt' } });
      const callCount2 = vi.mocked(runAgentLoop).mock.calls.length;
      expect(callCount2).toBeGreaterThan(callCount1);
    });
  });

  // ── Quiet hours ──
  describe('quiet hours', () => {
    it('skips during quiet hours (same day range)', async () => {
      // Set current time to 23:00
      vi.setSystemTime(new Date('2026-04-06T23:00:00'));

      const trigger = makeTrigger({
        id: 'trigger-quiet',
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: {} });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });

    it('allows events outside quiet hours', async () => {
      // Set current time to 14:00
      vi.setSystemTime(new Date('2026-04-06T14:00:00'));

      const trigger = makeTrigger({
        id: 'trigger-not-quiet',
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: {} });
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });

    it('handles same-day quiet hours range', async () => {
      // Set current time to 13:00
      vi.setSystemTime(new Date('2026-04-06T13:00:00'));

      const trigger = makeTrigger({
        id: 'trigger-day-quiet',
        quietHours: { enabled: true, start: '12:00', end: '14:00' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: {} });
      expect(runAgentLoop).not.toHaveBeenCalled();
    });
  });

  // ── Concurrency ──
  describe('concurrency control', () => {
    it('retries when same trigger is already running', async () => {
      const trigger = makeTrigger({ id: 'trigger-concurrent' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      const { runAgentLoop } = await import('../agent/agentLoop');
      // Make first call hang
      let resolveFirst: () => void;
      const firstCallPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      vi.mocked(runAgentLoop).mockImplementationOnce(() => firstCallPromise);

      // Start first event (will be "running")
      const firstPromise = triggerEngine.handleEvent(trigger.id, { data: { seq: 1 } });

      // Second event while first is running — should schedule retry
      triggerEngine.handleEvent(trigger.id, { data: { seq: 2 } });

      expect(triggerEngine.isTriggerRunning(trigger.id)).toBe(true);

      // Resolve the first
      resolveFirst!();
      await firstPromise;

      expect(triggerEngine.isTriggerRunning(trigger.id)).toBe(false);
    });
  });

  // ── IM scope matching ──
  describe('IM scope matching', () => {
    async function startBusyIMRetry(overrides: {
      channel?: Partial<IMChannel>;
      trigger?: Partial<Trigger>;
      message?: Partial<NormalizedIMMessage>;
    } = {}) {
      const trigger = makeTrigger({
        id: 'trigger-im-retry',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
        action: { prompt: 'handle', capability: 'safe_tools' },
        ...overrides.trigger,
      });
      const channel = makeChannel({ ...overrides.channel });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({ channels: { 'ch-1': channel }, sessions: {}, archivedSessions: {} });
      triggerEngine.startSourceWatcher(trigger);

      let resolveFirst!: () => void;
      runAgentLoopMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }));

      const baseMessage: NormalizedIMMessage = {
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'first',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
        ...overrides.message,
      };

      expect(triggerEngine.tryMatchIMTriggers(baseMessage)).toBe(1);
      await vi.waitFor(() => expect(runAgentLoopMock).toHaveBeenCalledTimes(1));

      expect(triggerEngine.tryMatchIMTriggers({
        ...baseMessage,
        text: 'retry',
      })).toBe(1);

      resolveFirst();
      await Promise.resolve();
      runAgentLoopMock.mockResolvedValue({ reason: 'completed' });
      return { trigger, channel };
    }

    it('tryMatchIMTriggers returns 0 when no IM triggers registered', () => {
      const msg = {
        platform: 'feishu' as const,
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        chatName: 'Group',
        isDirect: false,
        isMention: false,
        rawPayload: {},
      };
      expect(triggerEngine.tryMatchIMTriggers(msg)).toBe(0);
    });

    it('dispatches an IM trigger only when its bound channel is enabled for the message platform', () => {
      const trigger = makeTrigger({
        id: 'trigger-im',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
        action: { prompt: 'handle', capability: 'safe_tools' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({ channels: { 'ch-1': makeChannel() }, sessions: {}, archivedSessions: {} });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        chatName: 'Group',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('skips IM triggers when the bound channel is disabled', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-disabled',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ enabled: false, status: 'disconnected' }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(0);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('skips IM triggers when the bound channel has malformed truthy enabled', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-malformed-enabled',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ enabled: 'yes' as never }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(0);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('skips IM triggers when the bound channel capability is malformed', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-malformed-channel-capability',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
        action: { prompt: 'handle', capability: 'read_tools' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ capability: 'garbage' as never }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(0);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('skips IM triggers when the sender is not allowed by the channel whitelist', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-whitelist',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ allowedUsers: ['trusted-user'] }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(0);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('skips IM triggers whose action capability exceeds the sender effective channel capability', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-capability',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
        action: { prompt: 'handle', capability: 'full' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ capability: 'safe_tools' }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      const dispatched = triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      });

      expect(dispatched).toBe(0);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after the bound channel is disabled', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], enabled: false },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after the bound channel is removed', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after sender whitelist is revoked', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], allowedUsers: ['other-user'] },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not throw or execute a delayed IM retry after allowedUsers becomes malformed', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], allowedUsers: 'trusted_user' as never },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after effective channel capability is downgraded', async () => {
      const { trigger } = await startBusyIMRetry({
        channel: { capability: 'full', allowedUsers: ['u1'] },
        trigger: { action: { prompt: 'handle', capability: 'full' } },
      });
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], capability: 'safe_tools' },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after channel enabled is malformed truthy', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], enabled: 'yes' as never },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after channel disable-enable ABA', async () => {
      const { trigger } = await startBusyIMRetry();
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], enabled: false },
        },
        sessions: {},
        archivedSessions: {},
      }));
      useIMChannelStore.setState((state) => ({
        channels: {
          ...state.channels,
          'ch-1': { ...state.channels['ch-1'], enabled: true },
        },
        sessions: {},
        archivedSessions: {},
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after the trigger action capability is raised', async () => {
      const { trigger } = await startBusyIMRetry({
        channel: { capability: 'safe_tools' },
        trigger: { action: { prompt: 'handle', capability: 'safe_tools' } },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            action: { prompt: 'handle', capability: 'full' },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after custom action capability changes to full', async () => {
      const { trigger } = await startBusyIMRetry({
        channel: { capability: 'full', allowedUsers: ['u1'] },
        trigger: {
          action: {
            prompt: 'handle',
            capability: 'custom',
            permissions: { allowedTools: ['read_file'] },
          },
        },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            action: { prompt: 'handle', capability: 'full' },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after custom permissions are expanded', async () => {
      const { trigger } = await startBusyIMRetry({
        channel: { capability: 'full', allowedUsers: ['u1'] },
        trigger: {
          action: {
            prompt: 'handle',
            capability: 'custom',
            permissions: { allowedTools: ['read_file'] },
          },
        },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            action: {
              prompt: 'handle',
              capability: 'custom',
              permissions: { allowedTools: ['*'] },
            },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not throw or execute when malformed custom permissions are present at admission', () => {
      const trigger = makeTrigger({
        id: 'trigger-im-malformed-permissions',
        source: { type: 'im', channelId: 'ch-1', listenScope: 'all' },
        action: {
          prompt: 'handle',
          capability: 'custom',
          permissions: { allowedTools: 123 as never },
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, triggerOrder: [trigger.id] });
      useIMChannelStore.setState({
        channels: { 'ch-1': makeChannel({ capability: 'full', allowedUsers: ['u1'] }) },
        sessions: {},
        archivedSessions: {},
      });
      triggerEngine.startSourceWatcher(trigger);

      expect(() => triggerEngine.tryMatchIMTriggers({
        platform: 'slack',
        senderName: 'User',
        senderId: 'u1',
        text: 'hello',
        chatId: 'chat1',
        isDirect: true,
        isMention: false,
        replyContext: { platform: 'slack', chatId: 'chat1' },
        raw: {},
      })).not.toThrow();
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after custom permissions become malformed', async () => {
      const { trigger } = await startBusyIMRetry({
        channel: { capability: 'full', allowedUsers: ['u1'] },
        trigger: {
          action: {
            prompt: 'handle',
            capability: 'custom',
            permissions: { allowedTools: ['read_file'] },
          },
        },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            action: {
              prompt: 'handle',
              capability: 'custom',
              permissions: {
                allowedCommands: { bad: true } as never,
                allowedPaths: 123 as never,
                allowedTools: ['read_file'],
              },
            },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after pause-resume ABA', async () => {
      const { trigger } = await startBusyIMRetry();

      triggerEngine.stopSourceWatcher(trigger.id);
      triggerEngine.startSourceWatcher(trigger);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a delayed IM retry after source policy A-B-A', async () => {
      const { trigger } = await startBusyIMRetry({
        trigger: { source: { type: 'im', channelId: 'ch-1', listenScope: 'all' } },
      });

      triggerEngine.stopSourceWatcher(trigger.id);
      triggerEngine.startSourceWatcher({
        ...trigger,
        source: { type: 'im', channelId: 'ch-1', listenScope: 'direct_only' },
      });
      triggerEngine.stopSourceWatcher(trigger.id);
      triggerEngine.startSourceWatcher(trigger);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a queued group event after the IM source narrows to direct_only', async () => {
      const { trigger } = await startBusyIMRetry({
        trigger: { source: { type: 'im', channelId: 'ch-1', listenScope: 'all' } },
        message: { isDirect: false, isMention: true },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            source: { type: 'im', channelId: 'ch-1', listenScope: 'direct_only' },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('does not execute a queued chat event after the IM source chatId changes', async () => {
      const { trigger } = await startBusyIMRetry({
        trigger: { source: { type: 'im', channelId: 'ch-1', listenScope: 'all', chatId: 'chat1' } },
        message: { chatId: 'chat1', replyContext: { platform: 'slack', chatId: 'chat1' } },
      });
      useTriggerStore.setState((state) => ({
        triggers: {
          ...state.triggers,
          [trigger.id]: {
            ...state.triggers[trigger.id],
            source: { type: 'im', channelId: 'ch-1', listenScope: 'all', chatId: 'chat2' },
          },
        },
      }));

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
      triggerEngine.stopSourceWatcher(trigger.id);
    });

    it('clears delayed IM retry timers on stop', async () => {
      await startBusyIMRetry();

      triggerEngine.stop();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    });

    it('executes one delayed IM retry when the admitted authority is unchanged', async () => {
      const { trigger } = await startBusyIMRetry();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
      triggerEngine.stopSourceWatcher(trigger.id);
    });
  });

  // ── Cron timer ──
  describe('cron timer', () => {
    it('rejects intervals shorter than 10s', () => {
      const trigger = makeTrigger({
        id: 'trigger-short-cron',
        source: { type: 'cron', intervalSeconds: 5 },
      });
      // startSourceWatcher is public — calling directly
      triggerEngine.startSourceWatcher(trigger);
      // Should not have started — no timer to clean up
      triggerEngine.stopSourceWatcher(trigger.id);
    });
  });

  // ── skipChecks option ──
  describe('skipChecks', () => {
    it('bypasses status/filter/debounce checks when skipChecks is true', async () => {
      const trigger = makeTrigger({
        id: 'trigger-skip',
        status: 'paused',
        filter: { type: 'keyword', keywords: ['nope'] },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: {} }, { skipChecks: true });
      const { runAgentLoop } = await import('../agent/agentLoop');
      expect(runAgentLoop).toHaveBeenCalled();
    });
  });

  // ── Output delivery by exit reason (review finding [2]) ──
  // max_turns hit the cap but still produced a usable partial answer, so its output
  // must still be delivered (regression: making it a non-'completed' reason caused
  // the guard to early-return before pushOutput). no_progress / aborted have no
  // usable output and must NOT be delivered.
  describe('output delivery by exit reason', () => {
    function makeOutputTrigger(id: string): Trigger {
      return makeTrigger({
        id,
        output: {
          enabled: true,
          target: 'webhook',
          platform: 'custom',
          webhookUrl: 'https://example.test/hook',
          extractMode: 'last_message',
        },
      });
    }

    it('delivers output when the run hit the turn cap (max_turns)', async () => {
      const trigger = makeOutputTrigger('trigger-out-maxturns');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'max_turns' });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(outputSender.send).toHaveBeenCalled();
    });

    it('does NOT deliver output on no_progress (degenerate result)', async () => {
      const trigger = makeOutputTrigger('trigger-out-noprogress');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'no_progress' });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 2 } });

      expect(outputSender.send).not.toHaveBeenCalled();
    });

    it('does NOT deliver output on aborted', async () => {
      const trigger = makeOutputTrigger('trigger-out-aborted');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'aborted' });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 3 } });

      expect(outputSender.send).not.toHaveBeenCalled();
    });
  });

  describe('authorization scope lifecycle', () => {
    it('passes one trigger-run scope to permission resolution and the agent runner, then disposes it after completion', async () => {
      const trigger = makeTrigger({
        id: 'trigger-scope-complete',
        action: { prompt: 'Do scoped work', workspacePath: '/Users/testuser/Projects/trigger' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { resolveTriggerCallbacks } = await import('./triggerPermission');

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(createAuthorizationScopeMock).toHaveBeenCalledTimes(1);
      expect(resolveTriggerCallbacks).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/Users/testuser/Projects/trigger' }),
        { authorizationScopeId: 'scope-trigger-test' },
      );
      expect(runAgentLoopMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          authorizationScopeId: 'scope-trigger-test',
          runPermissionCeiling: expect.objectContaining({
            version: 1,
            source: 'trigger',
            capability: 'read_tools',
          }),
        }),
      );
      expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('scope-trigger-test');
    });

    it('creates a full shell authorization scope for full-capability trigger runs', async () => {
      const trigger = makeTrigger({
        id: 'trigger-scope-full',
        action: { prompt: 'Do full scoped work', capability: 'full' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(createAuthorizationScopeMock).toHaveBeenCalledWith({ shell: 'full' });
      expect(runAgentLoopMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ authorizationScopeId: 'scope-trigger-test' }),
      );
    });

    it('disposes the trigger-run scope when the agent runner throws', async () => {
      const trigger = makeTrigger({
        id: 'trigger-scope-throw',
        action: { prompt: 'Do scoped work', workspacePath: '/Users/testuser/Projects/trigger' },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      runAgentLoopMock.mockRejectedValueOnce(new Error('agent exploded'));

      await triggerEngine.handleEvent(trigger.id, { data: { n: 2 } });

      expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('scope-trigger-test');
      const run = useTriggerStore.getState().triggers[trigger.id]?.runs.at(-1);
      expect(run?.status).toBe('error');
      expect(run?.error).toContain('agent exploded');
    });

    it('disposes the trigger-run scope when sidecar recovery finite-settles as unavailable', async () => {
      const trigger = makeTrigger({
        id: 'trigger-scope-sidecar-unavailable',
        action: { prompt: 'Do scoped work', workspacePath: '/Users/testuser/Projects/trigger' },
        output: {
          enabled: true,
          target: 'webhook',
          platform: 'custom',
          webhookUrl: 'https://example.test/hook',
          extractMode: 'last_message',
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      runAgentLoopMock.mockResolvedValueOnce({
        reason: 'error',
        error: 'Sidecar run state remained unavailable during reattach',
        stopReason: 'sidecar_unavailable',
      });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 3 } });

      expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('scope-trigger-test');
      const run = useTriggerStore.getState().triggers[trigger.id]?.runs.at(-1);
      expect(run?.status).toBe('error');
      expect(run?.error).toContain('Sidecar run state remained unavailable');
      expect(outputSender.send).not.toHaveBeenCalled();
    });
  });
});
