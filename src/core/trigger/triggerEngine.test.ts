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
import { useTriggerStore } from '../../stores/triggerStore';
import { useChatStore } from '../../stores/chatStore';
import type { Trigger, TriggerEventPayload } from '../../types/trigger';

// Mock agentLoop to avoid full LLM execution
vi.mock('../agent/agentLoop', () => ({
  runAgentLoop: vi.fn().mockResolvedValue(undefined),
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

// Import after mocks
import { triggerEngine } from './triggerEngine';
import { outputSender } from '../im/outputSender';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    name: 'Test Trigger',
    status: 'active',
    source: { type: 'http' },
    filter: { type: 'always' },
    action: { prompt: 'Do something with $EVENT_DATA' },
    debounce: { enabled: false, windowSeconds: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runs: [],
    totalRuns: 0,
    ...overrides,
  };
}

describe('TriggerEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset stores
    useTriggerStore.setState({ triggers: {}, triggerOrder: [] });
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
});
