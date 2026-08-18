/**
 * Shared wire-contract fixture for the `agent.delta` reverse channel
 * (sidecar → shell). One canonical, positional argument list per method,
 * used by BOTH ends of the wire:
 *
 * - `sidecar/src/portFrameSenders.contract.test.ts` calls the real sender
 *   wrapper (`createFrameChatDelta`/`createFrameExecutionPort`) with each
 *   entry's `args` and asserts the pushed `{p, m, a}` frame's `a` equals
 *   `args`, in the SAME order.
 * - `src/core/agent/frameApplier.contract.test.ts` builds a frame
 *   `{p, m, a: args}` from each entry and asserts the real underlying port
 *   method (`ChatDelta`/`ExecutionPort`, spied via `setChatDelta`/
 *   `setExecutionPort`) is invoked with `args` spread, in the SAME order.
 *
 * Because both contract tests read the SAME entries, a one-sided change on
 * EITHER side of the wire — reordering/dropping/adding a positional
 * argument in `portFrameSenders.ts`'s `send(...)` call, or in
 * `frameApplier.ts`'s dispatch — breaks that side's test even if its own
 * local behavior stays internally self-consistent. This is deliberately a
 * SHARED file (sidecar test code importing from `src/` — sidecar test files
 * already do this, see `sidecar/src/agentLoopHost.test.ts` — the "sidecar
 * bundle must not import heavy src/ runtime modules" rule applies to
 * PRODUCTION bundle code, not test-only fixture data).
 *
 * Scope: only the "generic dispatch" methods are here — the ones both
 * `portFrameSenders.ts` and `frameApplier.ts` handle via plain
 * `send(method, args)` / `target[method](...a)`, with no id-preserving or
 * signature-translating special case. Four methods have such a special case
 * (chat `cancelStreaming`, exec `createExecution`, scratchpad `addEntry`,
 * session `replaceMessageById`) and are intentionally NOT listed here —
 * forcing their asymmetric wire shape into this uniform table would hide
 * exactly the behavior most worth pinning. Each contract test file has its
 * own dedicated test for those four, right next to its generic loop over
 * this fixture.
 *
 * TODO (not yet covered by either contract test — tracked here, not
 * silently dropped): none for chat/exec — this fixture + the 3 dedicated
 * special-case tests cover all 28 ChatDelta + all 14 ExecutionPort methods.
 * The `session` port's one method (`replaceMessageById`) is covered
 * separately, on BOTH sides: sender in
 * `sidecar/src/shims/conversationStorageRun.contract.test.ts` (its sender
 * lives in a different file, `conversationStorageRun.ts`, not
 * `portFrameSenders.ts` — it had zero prior test coverage), receiver via the
 * existing behavioral test in `frameApplier.test.ts`'s "session frames"
 * describe block.
 *
 * Completeness IS enforced, not just hoped for: both contract test files'
 * "fixture completeness" checks compare this fixture's method set against
 * `Object.keys(createInProcessChatDelta())` / `createInProcessExecutionPort()`
 * — the REAL interface's live method set — rather than a hardcoded count. A
 * newly added `ChatDelta`/`ExecutionPort` method with no fixture entry and
 * no dedicated special-case test turns that check red on both sides.
 * `ScratchpadPort` is the one exception: it has a single method (`addEntry`)
 * that IS the special case, so there is no "generic" subset left to compare
 * a key set against — its one dedicated test on each side is the coverage.
 */

export interface ContractFixtureEntry {
  port: 'chat' | 'exec';
  method: string;
  /** Positional args — identical on the call side and the wire side for
   *  every method in this table (see module doc for the 4 exceptions). */
  args: unknown[];
}

const sampleMessage = {
  id: 'm1',
  role: 'assistant' as const,
  content: 'hello',
  timestamp: 1700000000000,
};

const sampleToolCall = {
  id: 'tc1',
  name: 'read_file',
  input: { path: '/tmp/x.txt' },
};

const sampleToolResultContent = [{ type: 'text' as const, text: 'result text' }];

const sampleToolCallForContext = { toolCallId: 'tc1', name: 'read_file', input: {} };

const sampleUsage = { inputTokens: 10, outputTokens: 20 };

const sampleExecStepSnapshot = { id: 'step1', label: 'do thing', status: 'completed' as const };

const samplePlannedStep = { id: 'p1', content: 'plan step 1', status: 'pending' as const };

const sampleContextUsage = { used: 1000, limit: 200000, percent: 0.5 };

const sampleContextCache = { compressed: true, summary: 'compressed history' };

const sampleModel = { providerId: 'anthropic', modelId: 'claude-sonnet-5' };

const sampleProposalSignal = { kind: 'todo' as const, count: 2 };

const sampleToolExecutionMetadata = {
  sandboxRecovery: { kind: 'app-automation' as const, targetApp: 'Notes' },
};

const sampleExecutionStep = {
  id: 'step-1',
  executionId: 'exec-1',
  type: 'tool' as const,
  label: 'test step',
  status: 'running' as const,
  toolName: 'test_tool',
  toolInput: {},
  source: 'agent' as const,
  detailBlocks: [],
};

const sampleDetailBlock = {
  id: 'block-1',
  stepId: 'step-1',
  type: 'result' as const,
  label: 'result',
  content: 'hello',
  isTruncated: false,
  isExpanded: false,
};

/** All 27 generic-dispatch ChatDelta methods (28 total minus cancelStreaming). */
export const CHAT_CONTRACT_FIXTURES: ContractFixtureEntry[] = [
  { port: 'chat', method: 'appendText', args: ['conv-1', 'tok', 'msg-1'] },
  { port: 'chat', method: 'setLastMessageContent', args: ['conv-1', 'full content', 'msg-1'] },
  { port: 'chat', method: 'appendThinking', args: ['conv-1', 'thinking chunk', 'msg-1'] },
  { port: 'chat', method: 'setThinkingDuration', args: ['conv-1', 3.5, 'msg-1'] },
  { port: 'chat', method: 'flushTokens', args: ['conv-1', 'msg-1'] },
  { port: 'chat', method: 'finishStreaming', args: ['conv-1', 'msg-1'] },
  { port: 'chat', method: 'deactivateSkills', args: ['conv-1'] },
  { port: 'chat', method: 'setMessageStreamingFlag', args: ['conv-1', 'msg-1', true] },
  { port: 'chat', method: 'setMessageToolCalls', args: ['conv-1', 'msg-1', [sampleToolCall]] },
  { port: 'chat', method: 'addMessage', args: ['conv-1', sampleMessage] },
  { port: 'chat', method: 'deleteMessage', args: ['conv-1', 'msg-1', { skipCatalogBump: true, persist: false }] },
  {
    port: 'chat',
    method: 'updateToolCall',
    args: ['conv-1', 'msg-1', 'tc-1', 'tool result', sampleToolResultContent, true, false, sampleToolExecutionMetadata],
  },
  { port: 'chat', method: 'appendToolCallContext', args: ['conv-1', 'loop-1', sampleToolCallForContext] },
  { port: 'chat', method: 'updateMessageUsage', args: ['conv-1', sampleUsage, 'msg-1'] },
  { port: 'chat', method: 'setExecutionStepsSnapshot', args: ['conv-1', 'loop-1', [sampleExecStepSnapshot]] },
  { port: 'chat', method: 'setPlannedStepsSnapshot', args: ['conv-1', 'loop-1', [samplePlannedStep]] },
  { port: 'chat', method: 'setConversationStatus', args: ['conv-1', 'running'] },
  { port: 'chat', method: 'setAgentStatus', args: ['tool-calling', 'run_command', 'abu'] },
  { port: 'chat', method: 'setCurrentUsage', args: [sampleUsage] },
  { port: 'chat', method: 'setRetryInfo', args: [{ attempt: 2, maxAttempts: 5, delayMs: 1000 }] },
  { port: 'chat', method: 'setContextUsage', args: ['conv-1', sampleContextUsage] },
  { port: 'chat', method: 'setContextCache', args: ['conv-1', sampleContextCache] },
  { port: 'chat', method: 'clearContextCache', args: ['conv-1'] },
  { port: 'chat', method: 'setIsCompressing', args: ['conv-1', true] },
  { port: 'chat', method: 'setConversationModel', args: ['conv-1', sampleModel] },
  { port: 'chat', method: 'setPendingProposalSignal', args: ['conv-1', sampleProposalSignal] },
  { port: 'chat', method: 'removeActiveAgent', args: ['agent-1'] },
];

/** All 13 generic-dispatch ExecutionPort methods (14 total minus createExecution). */
export const EXEC_CONTRACT_FIXTURES: ContractFixtureEntry[] = [
  { port: 'exec', method: 'cancelExecution', args: ['loop-1'] },
  { port: 'exec', method: 'evictExecution', args: ['loop-1'] },
  { port: 'exec', method: 'completeExecution', args: ['loop-1'] },
  { port: 'exec', method: 'errorExecution', args: ['loop-1', 'boom'] },
  { port: 'exec', method: 'addStep', args: ['loop-1', sampleExecutionStep] },
  { port: 'exec', method: 'setStepResult', args: ['loop-1', 'step-1', 'step result'] },
  { port: 'exec', method: 'setStepError', args: ['loop-1', 'step-1', 'step error'] },
  { port: 'exec', method: 'addChildStep', args: ['loop-1', 'parent-1', sampleExecutionStep] },
  { port: 'exec', method: 'updateChildStep', args: ['loop-1', 'parent-1', 'child-1', 'child result', false] },
  { port: 'exec', method: 'addDetailBlock', args: ['loop-1', 'step-1', sampleDetailBlock] },
  { port: 'exec', method: 'appendThinking', args: ['loop-1', 'exec thinking chunk'] },
  { port: 'exec', method: 'setThinkingDuration', args: ['loop-1', 4.2] },
  { port: 'exec', method: 'setUsage', args: ['loop-1', sampleUsage] },
];
