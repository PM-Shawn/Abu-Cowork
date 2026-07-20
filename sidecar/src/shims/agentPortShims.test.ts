import { describe, it, expect } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import { getChatDelta, setChatDelta } from './chatDeltaRun';
import { getConversationReader, setConversationReader } from './conversationReaderRun';
import { getExecutionPort, setExecutionPort } from './executionPortRun';
import { getAbortRegistry, setAbortRegistry } from './abortRegistryRun';
import { getScratchpadPort, setScratchpadPort } from './scratchpadPortRun';
import { getToolInvoker, setToolInvoker } from './toolInvokerRun';
import { getCapsPort, setCapsPort } from './capsPortRun';
import { getWorkspaceReader, setWorkspaceReader } from './workspaceReaderRun';

/** Minimal fake context — only the fields each getter under test actually reads need to be real. */
function makeCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    runId: 'run-1',
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

describe('ALS-backed main-loop port shims', () => {
  describe('throw outside an active agentRunContext scope', () => {
    it.each([
      ['chatDelta', getChatDelta],
      ['conversationReader', getConversationReader],
      ['executionPort', getExecutionPort],
      ['abortRegistry', getAbortRegistry],
      ['scratchpadPort', getScratchpadPort],
      ['toolInvoker', getToolInvoker],
      ['capsPort', getCapsPort],
      ['workspaceReader', getWorkspaceReader],
    ])('%s getter throws', (_name, getter) => {
      expect(() => getter()).toThrow(/agent run context accessed outside/);
    });
  });

  describe('resolve from the ambient run context', () => {
    it('getChatDelta returns the run-scoped instance', () => {
      const marker = { appendText: () => {} } as unknown as AgentRunContext['chatDelta'];
      agentRunContext.run(makeCtx({ chatDelta: marker }), () => {
        expect(getChatDelta()).toBe(marker);
      });
    });

    it('getToolInvoker returns the run-scoped instance', () => {
      const marker = { getAllTools: () => [] } as unknown as AgentRunContext['toolInvoker'];
      agentRunContext.run(makeCtx({ toolInvoker: marker }), () => {
        expect(getToolInvoker()).toBe(marker);
      });
    });

    it('getCapsPort returns the run-scoped instance', () => {
      const marker = { get: () => undefined } as unknown as AgentRunContext['capsPort'];
      agentRunContext.run(makeCtx({ capsPort: marker }), () => {
        expect(getCapsPort()).toBe(marker);
      });
    });

    it('getWorkspaceReader returns the run-scoped instance', () => {
      const marker = { getCurrentPath: () => '/x' } as unknown as AgentRunContext['workspaceReader'];
      agentRunContext.run(makeCtx({ workspaceReader: marker }), () => {
        expect(getWorkspaceReader()).toBe(marker);
      });
    });
  });

  describe('two concurrent runs never see each other\'s ports (ALS isolation)', () => {
    it('interleaved async work resolves each run\'s own chatDelta', async () => {
      const gate: { resolveA?: () => void; resolveB?: () => void } = {};
      const waitA = new Promise<void>((resolve) => { gate.resolveA = resolve; });
      const waitB = new Promise<void>((resolve) => { gate.resolveB = resolve; });

      const markerA = { tag: 'A' } as unknown as AgentRunContext['chatDelta'];
      const markerB = { tag: 'B' } as unknown as AgentRunContext['chatDelta'];

      const resultsA: unknown[] = [];
      const resultsB: unknown[] = [];

      const runA = agentRunContext.run(makeCtx({ runId: 'a', chatDelta: markerA }), async () => {
        resultsA.push(getChatDelta());
        await waitB; // yield until B has also read, to force interleaving
        resultsA.push(getChatDelta());
        gate.resolveA?.();
      });

      const runB = agentRunContext.run(makeCtx({ runId: 'b', chatDelta: markerB }), async () => {
        resultsB.push(getChatDelta());
        gate.resolveB?.();
        await waitA;
        resultsB.push(getChatDelta());
      });

      await Promise.all([runA, runB]);

      expect(resultsA).toEqual([markerA, markerA]);
      expect(resultsB).toEqual([markerB, markerB]);
    });
  });

  describe('setX() functions throw (never slot-swapped, always injected via ALS)', () => {
    it.each([
      ['setChatDelta', () => setChatDelta({} as never)],
      ['setConversationReader', () => setConversationReader({} as never)],
      ['setExecutionPort', () => setExecutionPort({} as never)],
      ['setAbortRegistry', () => setAbortRegistry({} as never)],
      ['setScratchpadPort', () => setScratchpadPort({} as never)],
      ['setToolInvoker', () => setToolInvoker({} as never)],
      ['setCapsPort', () => setCapsPort({} as never)],
      ['setWorkspaceReader', () => setWorkspaceReader({} as never)],
    ])('%s throws', (_name, fn) => {
      expect(fn).toThrow(/never slot-swapped/);
    });
  });
});
