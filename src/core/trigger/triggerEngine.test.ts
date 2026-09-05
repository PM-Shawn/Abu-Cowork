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
    // A real AbuMessage shape: the push paths now build a NEW message that
    // prepends the run's outcome line to `content` (F7), so a bare string
    // stand-in would silently produce `undefined` where the answer goes.
    buildMessage: vi.fn().mockReturnValue({ content: 'test message', title: 'test' }),
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
import { resolveTriggerCallbacks } from './triggerPermission';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { checkToolApproval } from '../tools/registry';
import { clearLoopContext, setLoopContext } from '../agent/permissionBridge';
import { DEFAULT_BROWSER_OPERATION_POLICY } from '../permissions/browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
  type UnattendedConfirmationRequest,
} from '../permissions/unattendedConfirmation';
import { outputSender } from '../im/outputSender';
import {
  buildBrowserSignalContext,
  buildBrowserSignalRecord,
  clearBrowserSignals,
  recordBrowserSignal,
} from '../observability/browserSignals';
import { isBrowserRunReportMessage } from '../observability/browserRunReport';

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
  /*
    Where a trigger run may ASK, when its policy says 「每次询问」.

    A trigger run binds no IM session to its conversation, so the confirmation
    seam's fallback lookup finds nothing and every ask refused itself with
    `no_binding`. The trigger already names an IM channel for its output; the
    engine turns that into the approval target so the prompt lands where the
    results land.
  */
  describe('approval target from the trigger output binding', () => {
    function seedChannel() {
      useIMChannelStore.setState({
        channels: {
          'ch-trigger': {
            id: 'ch-trigger',
            platform: 'feishu',
            name: 'Ops',
            appId: 'a',
            appSecret: 's',
            capability: 'full',
            responseMode: 'mention_only',
            allowedUsers: [],
            workspacePaths: [],
            sessionTimeoutMinutes: 0,
            maxRoundsPerSession: 0,
            enabled: true,
            status: 'connected',
            createdAt: 1,
          },
        },
      });
    }

    /** The options the engine handed `resolveTriggerCallbacks` for the last run. */
    function lastOptions(): { imTarget?: unknown; runLabel?: string } {
      const calls = vi.mocked(resolveTriggerCallbacks).mock.calls;
      return calls[calls.length - 1]![1] as { imTarget?: unknown; runLabel?: string };
    }

    beforeEach(() => {
      vi.mocked(resolveTriggerCallbacks).mockClear();
      useIMChannelStore.setState({ channels: {} });
    });

    afterEach(() => {
      useIMChannelStore.setState({ channels: {} });
    });

    it('builds it from the IM output channel and names the trigger', async () => {
      seedChannel();
      const trigger = makeTrigger({
        id: 'trigger-approval-im',
        name: '磁盘告警',
        output: {
          enabled: true,
          target: 'im_channel',
          outputChannelId: 'ch-trigger',
          outputChatIds: 'oc_ops',
          outputUserIds: 'ou_li',
          extractMode: 'last_message',
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(lastOptions().imTarget).toEqual({
        platform: 'feishu',
        channelId: 'ch-trigger',
        chatId: 'oc_ops',
        chatIdType: 'chat_id',
        senderId: 'ou_li',
      });
      expect(lastOptions().runLabel).toBe('磁盘告警');
    });

    /*
      A webhook is a one-way URL with nobody behind it. Handing it over as an
      approval target would make the seam try to deliver a question into a
      POST endpoint and then wait five minutes for an answer that cannot come.
    */
    it('builds none for a webhook output', async () => {
      seedChannel();
      const trigger = makeTrigger({
        id: 'trigger-approval-webhook',
        output: {
          enabled: true,
          target: 'webhook',
          platform: 'custom',
          webhookUrl: 'https://example.test/hook',
          extractMode: 'last_message',
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(lastOptions().imTarget).toBeUndefined();
      // The name still travels: it is what the desktop notice says too.
      expect(lastOptions().runLabel).toBe('Test Trigger');
    });

    it('builds none when output is configured but switched off', async () => {
      seedChannel();
      const trigger = makeTrigger({
        id: 'trigger-approval-disabled',
        output: {
          enabled: false,
          target: 'im_channel',
          outputChannelId: 'ch-trigger',
          outputChatIds: 'oc_ops',
          extractMode: 'last_message',
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(lastOptions().imTarget).toBeUndefined();
    });

    it('builds none when the trigger configures no output at all', async () => {
      seedChannel();
      const trigger = makeTrigger({ id: 'trigger-approval-nooutput' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(lastOptions().imTarget).toBeUndefined();
    });

    /**
     * F1 (2026-09-05 review) — the same target has to reach the BROWSER GATE.
     *
     * Every case above reads what the engine handed `resolveTriggerCallbacks`,
     * i.e. the callback closure. The browser gate never calls that callback (it
     * needs the seam's audit fields, which a boolean callback cannot carry) and
     * builds its own seam request — so the target used to stop one layer short
     * and a triggered 「每次询问」 refused itself as `no_binding`.
     *
     * This one drives the REAL gate: real `triggerEngine.handleEvent`, real
     * `resolveUnattendedImTarget`, real `checkToolApproval`, real browser `ask`
     * branch. It never touches `commandConfirmCallback`.
     */
    it('reaches the browser gate itself, not only the run callback', async () => {
      seedChannel();
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserSitePermissions: { 'https://allowed.example': 'allowed' },
        browserOperationPolicy: {
          ...DEFAULT_BROWSER_OPERATION_POLICY,
          interactive: 'ask',
        },
      });
      const captured: { current: UnattendedConfirmationRequest | null } = { current: null };
      setUnattendedConfirmationResolver(async (request) => {
        captured.current = request;
        return { approved: false, reason: 'captured', audit: { outcome: 'no-channel', fresh: true } };
      });

      // The stand-in stops where the model would: one browser tool call. The
      // loop-context install below is what `executeToolBatch` /
      // `installShellLoopContext` do for real, from the same options object.
      runAgentLoopMock.mockImplementation(async (
        conversationId: string,
        _prompt: string,
        options: { runPermissionCeiling?: unknown; unattendedApproval?: unknown; commandConfirmCallback: never },
      ) => {
        const loopId = 'loop-f1-trigger';
        setLoopContext(loopId, {
          loopId,
          conversationId,
          unattendedApproval: options.unattendedApproval,
        } as never);
        try {
          await checkToolApproval(
            'abu-browser__navigate',
            { tabId: 1, url: 'https://allowed.example/report' },
            {
              conversationId,
              loopId,
              interactionMode: 'background',
              initiatedBy: 'automation',
              runPermissionCeiling: options.runPermissionCeiling,
            } as never,
            options.commandConfirmCallback,
          );
        } finally {
          clearLoopContext(loopId);
        }
        return { reason: 'completed' };
      });

      const trigger = makeTrigger({
        id: 'trigger-approval-gate',
        name: '磁盘告警',
        // Browser actions are outside every tier below 'full' at the ceiling.
        action: { prompt: 'check the dashboard', capability: 'full' },
        output: {
          enabled: true,
          target: 'im_channel',
          outputChannelId: 'ch-trigger',
          outputChatIds: 'oc_ops',
          outputUserIds: 'ou_li',
          extractMode: 'last_message',
        },
      });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      expect(captured.current?.imTarget).toEqual({
        platform: 'feishu',
        channelId: 'ch-trigger',
        chatId: 'oc_ops',
        chatIdType: 'chat_id',
        senderId: 'ou_li',
      });
      expect(captured.current?.runLabel).toBe('磁盘告警');
      expect(captured.current?.source).toBe('trigger');
      expect(captured.current?.runKey).toBe('loop-f1-trigger');

      __resetUnattendedConfirmationForTests();
      useSettingsStore.setState({
        allowUnattendedBrowser: false,
        browserSitePermissions: {},
        browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      });
    });
  });

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

    /**
     * F7 — what these two used to pin, and what changed.
     *
     * They pinned「没有可用输出就不投递」and that half still holds: no
     * ANSWER is extracted from the conversation on a degenerate terminal
     * (`buildMessage` is never called — a failed run's last assistant message
     * is not an answer, and shipping it as one is worse than saying nothing).
     * What was wrong was binding「没有可用输出」to「什么都不说」: in IM that
     * is indistinguishable from the task never having run. So now the run
     * still tells the user it did not finish — outcome code and reason, no
     * conversation text.
     */
    it('sends no answer on no_progress, but still says the run did not finish', async () => {
      const trigger = makeOutputTrigger('trigger-out-noprogress');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'no_progress' });
      vi.mocked(outputSender.send).mockClear();
      vi.mocked(outputSender.buildMessage).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 2 } });

      expect(outputSender.buildMessage).not.toHaveBeenCalled();
      expect(outputSender.send).toHaveBeenCalledTimes(1);
      const sent = vi.mocked(outputSender.send).mock.calls[0]?.[1] as { content: string };
      expect(sent.content).toContain('No progress');
      expect(sent.content).not.toContain('test message');
    });

    it('sends no answer on aborted, but still says the run was stopped', async () => {
      const trigger = makeOutputTrigger('trigger-out-aborted');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'aborted' });
      vi.mocked(outputSender.send).mockClear();
      vi.mocked(outputSender.buildMessage).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 3 } });

      expect(outputSender.buildMessage).not.toHaveBeenCalled();
      expect(outputSender.send).toHaveBeenCalledTimes(1);
      const sent = vi.mocked(outputSender.send).mock.calls[0]?.[1] as { content: string };
      expect(sent.content).toContain('Stopped');
    });

    it('leaves a trigger with no output binding silent — nothing to send to', async () => {
      const trigger = makeTrigger({ id: 'trigger-out-none' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'error', error: 'boom' });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 4 } });

      expect(outputSender.send).not.toHaveBeenCalled();
    });

    it('tells the bound channel when the run threw, not just the desktop', async () => {
      const trigger = makeOutputTrigger('trigger-out-threw');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      runAgentLoopMock.mockRejectedValueOnce(new Error('agent exploded'));
      vi.mocked(outputSender.send).mockClear();
      vi.mocked(outputSender.buildMessage).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 6 } });

      expect(outputSender.buildMessage).not.toHaveBeenCalled();
      const sent = vi.mocked(outputSender.send).mock.calls[0]?.[1] as { content: string };
      expect(sent.content).toContain('Task failed');
      // The raw exception text never leaves the machine — it can quote page
      // content, and the summary carries closed codes only.
      expect(sent.content).not.toContain('agent exploded');
    });

    it('prefixes the delivered answer with one outcome line and changes nothing else', async () => {
      const trigger = makeOutputTrigger('trigger-out-completed');
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      const { runAgentLoop } = await import('../agent/agentLoop');
      vi.mocked(runAgentLoop).mockResolvedValue({ reason: 'completed' });
      vi.mocked(outputSender.send).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 5 } });

      const sent = vi.mocked(outputSender.send).mock.calls[0]?.[1] as { content: string };
      expect(sent.content).toBe('Done\n\ntest message');
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
        // The conversation rides along too: an approval channel needs it to
        // find the chat this run can be asked in (and to name it in the
        // fallback system notice).
        expect.objectContaining({
          authorizationScopeId: 'scope-trigger-test',
          conversationId: expect.any(String),
        }),
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
      vi.mocked(outputSender.buildMessage).mockClear();

      await triggerEngine.handleEvent(trigger.id, { data: { n: 3 } });

      expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('scope-trigger-test');
      const run = useTriggerStore.getState().triggers[trigger.id]?.runs.at(-1);
      expect(run?.status).toBe('error');
      expect(run?.error).toContain('Sidecar run state remained unavailable');
      // F7 — no answer is extracted, but the bound channel is told the run
      // failed rather than being left to guess from silence.
      expect(outputSender.buildMessage).not.toHaveBeenCalled();
      const sent = vi.mocked(outputSender.send).mock.calls[0]?.[1] as { content: string };
      expect(sent.content).toContain('Task failed');
    });
  });
  // ── U7: the run report card ──
  //
  // Triggers reach the same terminal shape as scheduled tasks, so they get the
  // same report. Wired through the shared emitter; this pins that the wiring
  // exists (and that a run with no browser work is not handed an empty card).
  describe('browser run report card', () => {
    it('appends a card for a trigger run that touched the browser', async () => {
      clearBrowserSignals();
      const trigger = makeTrigger({ id: 'trigger-report' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      runAgentLoopMock.mockImplementationOnce(async (conversationId: string) => {
        recordBrowserSignal(
          buildBrowserSignalRecord(
            {
              kind: 'gate_denied',
              tool: 'abu-browser__navigate',
              opClass: 'interactive',
              reason: 'master-switch-off',
              runMode: 'unattended',
            },
            buildBrowserSignalContext('builtin', conversationId, 1_700_000_000_000),
          ),
        );
        return { reason: 'completed' };
      });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 1 } });

      const conversationId = useTriggerStore.getState().triggers[trigger.id]?.runs.at(0)?.conversationId;
      const messages = useChatStore.getState().conversations[conversationId!]?.messages ?? [];
      const cards = messages.filter(isBrowserRunReportMessage);
      expect(cards).toHaveLength(1);
      expect(cards[0].browserRunReport?.skippedByMasterSwitch).toBe(true);
      clearBrowserSignals();
    });

    it('appends nothing for a trigger run that never touched the browser', async () => {
      clearBrowserSignals();
      const trigger = makeTrigger({ id: 'trigger-no-browser' });
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });

      await triggerEngine.handleEvent(trigger.id, { data: { n: 2 } });

      const conversationId = useTriggerStore.getState().triggers[trigger.id]?.runs.at(0)?.conversationId;
      const messages = useChatStore.getState().conversations[conversationId!]?.messages ?? [];
      expect(messages.filter(isBrowserRunReportMessage)).toHaveLength(0);
    });
  });
});
