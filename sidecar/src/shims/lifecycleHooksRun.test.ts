import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';
import * as rpcClient from '../rpcClient';
import { emitHook } from './lifecycleHooksRun';
import type { HookEvent, PostToolCallEvent, PreToolCallEvent } from '@/core/agent/lifecycleHooks';

function makeAgentCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    runId: 'main-run-1',
    conversationId: 'conv-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'en-US',
    pushFrame: () => {},
    ...overrides,
  };
}

const postToolEvent: PostToolCallEvent = {
  type: 'postToolCall',
  timestamp: 1,
  conversationId: 'conv-1',
  toolName: 'read_file',
  toolInput: {},
  result: 'ok',
  error: false,
  durationMs: 5,
};

const preToolEvent: PreToolCallEvent = {
  type: 'preToolCall',
  timestamp: 1,
  conversationId: 'conv-1',
  toolName: 'write_file',
  toolInput: {},
};

describe('lifecycleHooksRun shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('main-loop path (agentRunContext) — the P1-3B-3B fix', () => {
    it('postToolCall (notification) forwards with the agentRunContext runId', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      agentRunContext.run(makeAgentCtx({ runId: 'main-run-1' }), () => {
        const result = emitHook(postToolEvent);
        expect(result).toBe(postToolEvent); // fire-and-forget returns the event synchronously
      });
      expect(spy).toHaveBeenCalledWith('hook.notify', { runId: 'main-run-1', event: postToolEvent });
    });

    it('preToolCall (request) forwards with the agentRunContext runId and awaits the response', async () => {
      const spy = vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue({ ...preToolEvent, blocked: true });
      const result = await agentRunContext.run(makeAgentCtx({ runId: 'main-run-1' }), () => emitHook(preToolEvent));
      expect(spy).toHaveBeenCalledWith('hook.emit', { runId: 'main-run-1', event: preToolEvent });
      expect((result as HookEvent & { blocked?: boolean }).blocked).toBe(true);
    });
  });

  describe('subagent path (subagentRunContext fallback, unchanged from P1-3a)', () => {
    it('resolves the runId from subagentRunContext when agentRunContext is not active', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      subagentRunContext.run(
        { runId: 'sub-run-1', locale: 'en-US', uiStrings: {} as never, resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false } },
        () => emitHook(postToolEvent),
      );
      expect(spy).toHaveBeenCalledWith('hook.notify', { runId: 'sub-run-1', event: postToolEvent });
    });
  });

  describe('nested subagent inside a main-loop run — agentRunContext takes priority', () => {
    it('uses the main loop\'s runId, not a stale subagent one, when both scopes are active', () => {
      const spy = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});
      subagentRunContext.run(
        { runId: 'stale-sub-run', locale: 'en-US', uiStrings: {} as never, resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false } },
        () => {
          agentRunContext.run(makeAgentCtx({ runId: 'main-run-1' }), () => emitHook(postToolEvent));
        },
      );
      expect(spy).toHaveBeenCalledWith('hook.notify', { runId: 'main-run-1', event: postToolEvent });
    });
  });

  it('throws a clear error when called outside both agentRunContext and subagentRunContext', () => {
    expect(() => emitHook(postToolEvent)).toThrow(/no run context available/);
  });
});
