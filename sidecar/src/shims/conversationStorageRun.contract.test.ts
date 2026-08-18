/**
 * Wire-contract test — SENDER side, `session` port's one method
 * (`replaceMessageById`). Unlike the chat/exec fixture-driven tests
 * (`portFrameSenders.contract.test.ts` / `frameApplier.contract.test.ts`),
 * this method's sender lives in `conversationStorageRun.ts` (not
 * `portFrameSenders.ts`) and had ZERO existing test coverage before this
 * file — `frameApplier.test.ts`'s "session frames" describe block already
 * covers the RECEIVER side (real `replaceMessageById` gets called with the
 * frame's args), but nothing previously pinned what `conversationStorageRun.ts`
 * actually PUTS on the wire.
 */
import { describe, it, expect } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import type { PortFrame } from '../portFrameCoalescer';
import { replaceMessageById } from './conversationStorageRun';

function makeCtx(pushFrame: (frame: PortFrame) => void): AgentRunContext {
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
    pushFrame,
  };
}

describe('conversationStorageRun.replaceMessageById wire contract', () => {
  it('pushes {p:"session", m:"replaceMessageById", a:[convId, message]} — matching frameApplier.ts\'s applySessionFrame unpacking exactly', async () => {
    const frames: PortFrame[] = [];
    const message = { id: 'm1', role: 'assistant' as const, content: 'final', timestamp: 1700000000000 };

    await agentRunContext.run(makeCtx((f) => frames.push(f)), async () => {
      await replaceMessageById('conv-1', message);
    });

    expect(frames).toEqual([{ p: 'session', m: 'replaceMessageById', a: ['conv-1', message] }]);
  });
});
