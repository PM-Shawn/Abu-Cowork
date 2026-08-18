/**
 * Wire-contract test — RECEIVER side. Pins `frameApplier.ts`'s dispatch for
 * every method in the shared fixture (`__contractFixtures__/
 * portFrameFixtures.ts` — see that file's doc for why it's shared with the
 * SENDER-side contract test, `sidecar/src/portFrameSenders.contract.test.ts`,
 * and what's out of scope).
 *
 * Unlike `frameApplier.test.ts` (behavioral: asserts real chatStore/
 * taskExecutionStore/scratchpadStore state after applying a handful of
 * frames), this file swaps in a SPY `ChatDelta`/`ExecutionPort`
 * implementation (via `setChatDelta`/`setExecutionPort`) and asserts the
 * exact positional args each real port method receives, for ALL 40 generic
 * methods plus the special cases — so a change to `applyChatFrame`/
 * `applyExecFrame`'s dispatch order (or to the shared fixture reflecting a
 * `portFrameSenders.ts` change) turns THIS file red even when
 * `frameApplier.test.ts`'s handful of behavioral assertions still pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getChatDelta, setChatDelta, createInProcessChatDelta, type ChatDelta } from './ports/chatDelta';
import { getExecutionPort, setExecutionPort, createInProcessExecutionPort, type ExecutionPort } from './ports/executionPort';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useScratchpadStore } from '@/stores/scratchpadStore';
import { CHAT_CONTRACT_FIXTURES, EXEC_CONTRACT_FIXTURES } from './__contractFixtures__/portFrameFixtures';
import { applyDeltaFrames } from './frameApplier';

const CHAT_METHOD_NAMES: (keyof ChatDelta)[] = [
  'appendText', 'setLastMessageContent', 'appendThinking', 'setThinkingDuration', 'flushTokens',
  'finishStreaming', 'cancelStreaming', 'deactivateSkills', 'setMessageStreamingFlag', 'setMessageToolCalls',
  'addMessage', 'deleteMessagesFrom', 'updateToolCall', 'appendToolCallContext', 'updateMessageUsage',
  'setExecutionStepsSnapshot', 'setPlannedStepsSnapshot', 'setConversationStatus', 'setAgentStatus',
  'setCurrentUsage', 'setRetryInfo', 'setContextUsage', 'setContextCache', 'clearContextCache',
  'setIsCompressing', 'setConversationModel', 'setPendingProposalSignal', 'removeActiveAgent',
];

const EXEC_METHOD_NAMES: (keyof ExecutionPort)[] = [
  'createExecution', 'cancelExecution', 'getExecutionByLoopId', 'getExecutionByConversationId', 'evictExecution',
  'completeExecution', 'errorExecution', 'addStep', 'setStepResult', 'setStepError', 'addChildStep',
  'updateChildStep', 'addDetailBlock', 'appendThinking', 'setThinkingDuration', 'setUsage',
];

/** Methods with their own dedicated special-case test above (id-preserving
 *  or signature-translating) — deliberately excluded from the generic
 *  fixture's completeness check, not just forgotten. */
const CHAT_SPECIAL_CASED = new Set(['cancelStreaming']);
const EXEC_SPECIAL_CASED = new Set([
  'createExecution',
  // Reads never travel as frames at all (see frameApplier.ts's module doc) —
  // not part of the generic-dispatch WRITE surface this fixture covers.
  'getExecutionByLoopId',
  'getExecutionByConversationId',
]);

function makeSpyChatDelta(): ChatDelta {
  const spy = {} as Record<string, ReturnType<typeof vi.fn>>;
  for (const name of CHAT_METHOD_NAMES) spy[name] = vi.fn();
  return spy as unknown as ChatDelta;
}

function makeSpyExecutionPort(): ExecutionPort {
  const spy = {} as Record<string, ReturnType<typeof vi.fn>>;
  for (const name of EXEC_METHOD_NAMES) spy[name] = vi.fn();
  return spy as unknown as ExecutionPort;
}

describe('frameApplier wire contract', () => {
  let chatSpy: ChatDelta;
  let execSpy: ExecutionPort;

  beforeEach(() => {
    chatSpy = makeSpyChatDelta();
    execSpy = makeSpyExecutionPort();
    setChatDelta(chatSpy);
    setExecutionPort(execSpy);
    // The two special-case tests below (createExecution / addEntry) bypass
    // the spies and hit the REAL stores directly — reset them so those
    // tests don't depend on ordering against other test files.
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useScratchpadStore.setState({ entries: {}, order: [] });
  });

  afterEach(() => {
    // Restore the real in-process implementations so this file never leaks
    // a spy into another test file's module-level port slot.
    setChatDelta(createInProcessChatDelta());
    setExecutionPort(createInProcessExecutionPort());
  });

  describe('chat frames (generic dispatch)', () => {
    it.each(CHAT_CONTRACT_FIXTURES)('$method: frame.a is spread onto the real ChatDelta method in order', async ({ method, args }) => {
      await applyDeltaFrames([{ p: 'chat', m: method, a: args }]);
      const spyFn = (getChatDelta() as unknown as Record<string, ReturnType<typeof vi.fn>>)[method];
      expect(spyFn).toHaveBeenCalledTimes(1);
      expect(spyFn).toHaveBeenCalledWith(...args);
    });
  });

  describe('exec frames (generic dispatch)', () => {
    it.each(EXEC_CONTRACT_FIXTURES)('$method: frame.a is spread onto the real ExecutionPort method in order', async ({ method, args }) => {
      await applyDeltaFrames([{ p: 'exec', m: method, a: args }]);
      const spyFn = (getExecutionPort() as unknown as Record<string, ReturnType<typeof vi.fn>>)[method];
      expect(spyFn).toHaveBeenCalledTimes(1);
      expect(spyFn).toHaveBeenCalledWith(...args);
    });
  });

  describe('special cases (asymmetric wire shape — the trickiest, most valuable part of the contract)', () => {
    it('chat cancelStreaming: wire frame [convId] is applied as cancelStreaming(convId, {fromSidecarFrame: true}) — the flag is synthesized here, never sent over the wire', async () => {
      await applyDeltaFrames([{ p: 'chat', m: 'cancelStreaming', a: ['conv-1'] }]);
      expect(chatSpy.cancelStreaming).toHaveBeenCalledWith('conv-1', { fromSidecarFrame: true });
    });

    it('exec createExecution: wire frame [conversationId, loopId] is applied via the id-preserving applyExecutionWithId, not a raw ExecutionPort.createExecution(...a) call', async () => {
      await applyDeltaFrames([{ p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] }]);
      // The real in-process createExecution was swapped out for a spy that
      // returns undefined — applyExecutionWithId (executionPort.ts) creates
      // the execution directly on the store with id === loopId, bypassing
      // this spy entirely. Proving that means proving the spy was NOT
      // called with the generic-dispatch shape.
      expect(execSpy.createExecution).not.toHaveBeenCalled();
    });

    it('scratchpad addEntry: wire frame [id, entry] is applied via the id-preserving applyScratchpadEntryWithId, using the SIDECAR-supplied id', async () => {
      await applyDeltaFrames([
        { p: 'scratchpad', m: 'addEntry', a: ['sidecar-id-1', { conversationId: 'conv-1', title: 't', type: 'summary', content: 'c' }] },
      ]);
      expect(useScratchpadStore.getState().entries['sidecar-id-1']).toMatchObject({ id: 'sidecar-id-1', content: 'c' });
    });
  });

  describe('fixture completeness', () => {
    // Compares against the REAL interface's method key set (via its
    // canonical in-process implementation), not a hardcoded count — a newly
    // added ChatDelta/ExecutionPort method with no fixture entry (and no
    // dedicated special-case test) turns this red instead of silently going
    // uncovered.
    it('the shared fixture covers every generic-dispatch ChatDelta method (all of them, minus the special-cased ones)', () => {
      const realMethods = new Set(Object.keys(createInProcessChatDelta()));
      const expectedGenericMethods = [...realMethods].filter((m) => !CHAT_SPECIAL_CASED.has(m)).sort();
      const fixtureMethods = CHAT_CONTRACT_FIXTURES.map((f) => f.method).sort();
      expect(fixtureMethods).toEqual(expectedGenericMethods);
    });

    it('the shared fixture covers every generic-dispatch ExecutionPort WRITE method (all of them, minus the special-cased ones)', () => {
      const realMethods = new Set(Object.keys(createInProcessExecutionPort()));
      const expectedGenericMethods = [...realMethods].filter((m) => !EXEC_SPECIAL_CASED.has(m)).sort();
      const fixtureMethods = EXEC_CONTRACT_FIXTURES.map((f) => f.method).sort();
      expect(fixtureMethods).toEqual(expectedGenericMethods);
    });
  });
});
