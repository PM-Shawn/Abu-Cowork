/**
 * Sidecar-side frame-sender port implementations — P1-3b-2 item 2. Each
 * factory implements the FULL corresponding in-process port interface
 * (`ChatDelta` / `ExecutionPort` / `ScratchpadPort` from `src/core/agent/
 * ports/*`) by pushing wire frames `{ p, m, a }` instead of touching a
 * Zustand store directly — the sidecar-run agent loop (3b-3) constructs one
 * of each per run and injects them the same way `subagentHost.ts` injects
 * per-run ports today.
 *
 * Transport-agnostic by construction: `push` is an injected callback (a
 * `PortFrame => void`, matching `portFrameCoalescer.ts`'s `push()`), never
 * a direct RPC call — tests exercise these factories with a plain
 * array-collecting `push` and no live pipe. 3b-3 wires `push` to a
 * `createPortFrameCoalescer(...).push`.
 *
 * DORMANT this batch: nothing in the sidecar's real dispatch path
 * constructs these yet (3b-3's per-run host is the first caller).
 *
 * Type-only imports from `@/core/agent/ports/*`/`@/types/*` — erased at
 * build time, so this file carries zero runtime dependency on the real
 * Zustand-store-backed implementations (same discipline as
 * `subagentHost.ts`'s existing `SettingsReader`/`ToolInvoker`/`CapsPort`/
 * `WorkspaceReader` type-only imports).
 */
import type { ChatDelta } from '@/core/agent/ports/chatDelta';
import type { ExecutionPort } from '@/core/agent/ports/executionPort';
import type { ScratchpadPort } from '@/core/agent/ports/scratchpadPort';
import type { ScratchpadEntry } from '@/stores/scratchpadStore';
import type { TaskExecution, ExecutionStep, DetailBlock } from '@/types/execution';
import type { TokenUsage } from '@/types';
import type { PortFrame } from './portFrameCoalescer';

type Push = (frame: PortFrame) => void;

// ── ChatDelta ────────────────────────────────────────────────────────────

/**
 * `onLocalApply`, if given, is invoked SYNCHRONOUSLY BEFORE the frame is
 * pushed — a seam for 3b-3's conversation run-mirror (design doc §3's
 * "conversationReader" row: "sidecar chatDelta 发帧前同步 apply 到本地镜像") to
 * write-through into its own local conversation snapshot. This batch does
 * NOT build that mirror — `onLocalApply` is just a callback hook here.
 *
 * All 28 `ChatDelta` methods are `void` (verified by reading chatDelta.ts —
 * none return a value the loop consumes), so every one is safely
 * fire-and-forget: push the frame, return undefined. No method needed a
 * "return value consumed by the loop" branch — see P1-3B-2-REPORT.md's
 * inventory for the full 28-method check.
 */
export function createFrameChatDelta(push: Push, onLocalApply?: (m: string, a: unknown[]) => void): ChatDelta {
  function send(m: string, a: unknown[]): void {
    onLocalApply?.(m, a);
    push({ p: 'chat', m, a });
  }

  return {
    appendText: (convId, token, msgId) => send('appendText', [convId, token, msgId]),
    setLastMessageContent: (convId, content, msgId) => send('setLastMessageContent', [convId, content, msgId]),
    appendThinking: (convId, thinking, msgId) => send('appendThinking', [convId, thinking, msgId]),
    setThinkingDuration: (convId, duration, msgId) => send('setThinkingDuration', [convId, duration, msgId]),
    flushTokens: (convId, msgId) => send('flushTokens', [convId, msgId]),
    finishStreaming: (convId, msgId) => send('finishStreaming', [convId, msgId]),
    cancelStreaming: (convId) => send('cancelStreaming', [convId]),
    deactivateSkills: (convId) => send('deactivateSkills', [convId]),
    setMessageStreamingFlag: (convId, messageId, streaming) =>
      send('setMessageStreamingFlag', [convId, messageId, streaming]),
    setMessageToolCalls: (convId, messageId, toolCalls) => send('setMessageToolCalls', [convId, messageId, toolCalls]),
    addMessage: (convId, message) => send('addMessage', [convId, message]),
    deleteMessagesFrom: (convId, messageId) => send('deleteMessagesFrom', [convId, messageId]),
    updateToolCall: (convId, messageId, toolCallId, result, resultContent, isError, hideScreenshot, metadata) =>
      send('updateToolCall', [
        convId,
        messageId,
        toolCallId,
        result,
        resultContent,
        isError,
        hideScreenshot,
        metadata,
      ]),
    appendToolCallContext: (convId, loopId, context) => send('appendToolCallContext', [convId, loopId, context]),
    appendMessageToolCall: (convId, loopId, toolCall) => send('appendMessageToolCall', [convId, loopId, toolCall]),
    updateMessageUsage: (convId, usage, msgId) => send('updateMessageUsage', [convId, usage, msgId]),
    setExecutionStepsSnapshot: (convId, loopId, steps) => send('setExecutionStepsSnapshot', [convId, loopId, steps]),
    setPlannedStepsSnapshot: (convId, loopId, steps) => send('setPlannedStepsSnapshot', [convId, loopId, steps]),
    setConversationStatus: (convId, status) => send('setConversationStatus', [convId, status]),
    setAgentStatus: (status, tool, agentName) => send('setAgentStatus', [status, tool, agentName]),
    setCurrentUsage: (usage) => send('setCurrentUsage', [usage]),
    setRetryInfo: (info) => send('setRetryInfo', [info]),
    setContextUsage: (convId, usage) => send('setContextUsage', [convId, usage]),
    setContextCache: (convId, cache) => send('setContextCache', [convId, cache]),
    clearContextCache: (convId) => send('clearContextCache', [convId]),
    setIsCompressing: (convId, value) => send('setIsCompressing', [convId, value]),
    setConversationModel: (convId, model) => send('setConversationModel', [convId, model]),
    setPendingProposalSignal: (convId, signal) => send('setPendingProposalSignal', [convId, signal]),
    removeActiveAgent: (agentName) => send('removeActiveAgent', [agentName]),
  };
}

// ── ExecutionPort ────────────────────────────────────────────────────────

/**
 * Per-run LOCAL in-memory execution mirror — the sidecar is the only writer
 * during a run (design doc §3's "conversationReader" row's "write-through-
 * mirror" idea, applied here to executions instead of the conversation),
 * so reads (`getExecutionByLoopId`/`getExecutionByConversationId` — the
 * only two read methods the loop path actually calls, per the grep
 * inventory in P1-3B-2-REPORT.md: `agentLoop.ts:200`,
 * `plannedStepsPrompt.ts:29`) can be served locally without a round trip,
 * while every write ALSO pushes a frame so the shell's real
 * `taskExecutionStore` stays byte-identical by the time the run ends.
 *
 * Id convention: `createExecution`'s returned `TaskExecution.id` is set to
 * `loopId` itself (NOT a freshly generated random id) — `loopId` is already
 * unique per run (minted once, shell-side, at dispatch), so there is no
 * separate id-generation/translation step needed to keep this local mirror
 * and the shell's real store in agreement: the shell-side applier
 * (`frameApplier.ts`) re-derives `id === loopId` from the SAME two frame
 * args (`conversationId`, `loopId`) rather than requiring a third `id` arg
 * over the wire. See `taskExecutionStore.ts`'s `createExecutionWithId` doc
 * comment for the shell-side half of this contract.
 *
 * Every write method below mirrors the real `taskExecutionStore.ts`
 * action's guard behavior exactly (silently no-ops on an unknown id,
 * mirrors status/endTime/duration bookkeeping) — this is NOT a shortcut
 * implementation, it is byte-for-byte behavior parity so the local reads a
 * loop performs mid-run see the same shape the real store will end up with.
 *
 * KNOWN GAP (escalated, not silently papered over — see
 * P1-3B-2-REPORT.md): `TaskExecution.plannedSteps` is mutated SHELL-SIDE
 * directly on the real store by `memoryTools.ts`'s `report_plan` tool
 * (`useTaskExecutionStore.getState().setPlannedSteps(...)`), bypassing
 * `ExecutionPort` entirely — `setPlannedSteps`/`markPlanParsed` are not
 * part of the `ExecutionPort` interface at all (see executionPort.ts's
 * "Scope note": deliberately not added, "NOT used by either agentLoop.ts
 * or eventRouter.ts"... except `plannedStepsPrompt.ts` DOES read
 * `exec.plannedSteps` via `getExecutionByConversationId`). Since all tool
 * execution (including `report_plan`) stays shell-side in 3b (design doc
 * §2 雷3), this local mirror has NO way to observe that write via frames —
 * `plannedSteps` on every locally-mirrored execution stays `[]` for the
 * lifetime of this batch's machinery. This is a real design gap for 3b-3,
 * not something fixable inside this transport-agnostic factory — flagged
 * per the card's "STOP and record" instruction rather than invented around.
 */
export function createFrameExecutionPort(push: Push): ExecutionPort {
  const executions = new Map<string, TaskExecution>(); // keyed by id === loopId

  function findStep(exec: TaskExecution, stepId: string): ExecutionStep | undefined {
    return exec.steps.find((s) => s.id === stepId);
  }

  return {
    createExecution: (conversationId, loopId) => {
      const execution: TaskExecution = {
        id: loopId,
        conversationId,
        loopId,
        status: 'running',
        startTime: Date.now(),
        plannedSteps: [],
        planParsed: false,
        steps: [],
      };
      executions.set(loopId, execution);
      push({ p: 'exec', m: 'createExecution', a: [conversationId, loopId] });
      return execution;
    },

    cancelExecution: (execId) => {
      const exec = executions.get(execId);
      if (exec) {
        exec.status = 'cancelled';
        exec.endTime = Date.now();
      }
      push({ p: 'exec', m: 'cancelExecution', a: [execId] });
    },

    getExecutionByLoopId: (loopId) => executions.get(loopId),

    getExecutionByConversationId: (conversationId) => {
      let best: TaskExecution | undefined;
      for (const exec of executions.values()) {
        if (exec.conversationId !== conversationId) continue;
        if (!best || exec.startTime >= best.startTime) best = exec;
      }
      return best;
    },

    evictExecution: (execId) => {
      const exec = executions.get(execId);
      // Mirrors taskExecutionStore's own guard: only non-running executions evict.
      if (exec && exec.status !== 'running') {
        executions.delete(execId);
      }
      push({ p: 'exec', m: 'evictExecution', a: [execId] });
    },

    completeExecution: (execId) => {
      const exec = executions.get(execId);
      if (exec) {
        exec.status = 'completed';
        exec.endTime = Date.now();
        // plannedSteps status flip is a no-op here — see the KNOWN GAP doc
        // comment above (plannedSteps never populates on this local mirror).
      }
      push({ p: 'exec', m: 'completeExecution', a: [execId] });
    },

    errorExecution: (execId, error) => {
      const exec = executions.get(execId);
      if (exec) {
        exec.status = 'error';
        exec.endTime = Date.now();
      }
      push({ p: 'exec', m: 'errorExecution', a: [execId, error] });
    },

    addStep: (execId, step) => {
      const exec = executions.get(execId);
      if (exec) exec.steps.push(step);
      push({ p: 'exec', m: 'addStep', a: [execId, step] });
    },

    setStepResult: (execId, stepId, result) => {
      const exec = executions.get(execId);
      const step = exec ? findStep(exec, stepId) : undefined;
      if (step) {
        step.toolResult = result;
        step.status = 'completed';
        step.endTime = Date.now();
        if (step.startTime) step.duration = (step.endTime - step.startTime) / 1000;
      }
      push({ p: 'exec', m: 'setStepResult', a: [execId, stepId, result] });
    },

    setStepError: (execId, stepId, error) => {
      const exec = executions.get(execId);
      const step = exec ? findStep(exec, stepId) : undefined;
      if (step) {
        step.errorMessage = error;
        step.status = 'error';
        step.endTime = Date.now();
        if (step.startTime) step.duration = (step.endTime - step.startTime) / 1000;
      }
      push({ p: 'exec', m: 'setStepError', a: [execId, stepId, error] });
    },

    addChildStep: (execId, parentStepId, childStep) => {
      const exec = executions.get(execId);
      const parent = exec ? findStep(exec, parentStepId) : undefined;
      if (parent) {
        if (!parent.childSteps) parent.childSteps = [];
        parent.childSteps.push(childStep);
      }
      push({ p: 'exec', m: 'addChildStep', a: [execId, parentStepId, childStep] });
    },

    updateChildStep: (execId, parentStepId, childStepId, result, error, detailBlocks) => {
      const exec = executions.get(execId);
      const parent = exec ? findStep(exec, parentStepId) : undefined;
      const child = parent?.childSteps?.find((s) => s.id === childStepId);
      if (child) {
        child.toolResult = result;
        child.status = error ? 'error' : 'completed';
        if (error) child.errorMessage = result;
        child.endTime = Date.now();
        if (child.startTime) child.duration = (child.endTime - child.startTime) / 1000;
        if (detailBlocks?.length) child.detailBlocks.push(...detailBlocks);
      }
      push({ p: 'exec', m: 'updateChildStep', a: [execId, parentStepId, childStepId, result, error, detailBlocks] });
    },

    addDetailBlock: (execId, stepId, block: DetailBlock) => {
      const exec = executions.get(execId);
      const step = exec ? findStep(exec, stepId) : undefined;
      if (step) step.detailBlocks.push(block);
      push({ p: 'exec', m: 'addDetailBlock', a: [execId, stepId, block] });
    },

    appendThinking: (execId, content) => {
      const exec = executions.get(execId);
      if (exec) exec.thinking = (exec.thinking || '') + content;
      push({ p: 'exec', m: 'appendThinking', a: [execId, content] });
    },

    setThinkingDuration: (execId, duration) => {
      const exec = executions.get(execId);
      if (exec) exec.thinkingDuration = duration;
      push({ p: 'exec', m: 'setThinkingDuration', a: [execId, duration] });
    },

    setUsage: (execId, usage: TokenUsage) => {
      const exec = executions.get(execId);
      if (exec) exec.usage = usage;
      push({ p: 'exec', m: 'setUsage', a: [execId, usage] });
    },
  };
}

// ── ScratchpadPort ───────────────────────────────────────────────────────

/** Same local-id-generation pattern as scratchpadStore.ts's own `generateId()` — kept independent (not imported) for the same "src/ never depended on by sidecar/ at the type level, sidecar/ never runtime-imports src/ stores" reason `frameApplier.ts` documents for the reverse direction. */
function generateScratchpadId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/**
 * `addEntry` must return the new entry's `string` id SYNCHRONOUSLY (loop
 * code may use it immediately) — so the id is generated HERE, sidecar-side,
 * and threaded as the frame's first arg so the shell's id-preserving apply
 * (`ports/scratchpadPort.ts`'s `applyScratchpadEntryWithId`, via
 * `frameApplier.ts`) uses the SAME id rather than minting its own. See
 * `scratchpadStore.ts`'s `addEntryWithId` doc comment for the shell-side
 * half of this contract.
 */
export function createFrameScratchpadPort(push: Push): ScratchpadPort {
  return {
    addEntry: (entry: Omit<ScratchpadEntry, 'id' | 'timestamp' | 'isViewed'>) => {
      const id = generateScratchpadId();
      push({ p: 'scratchpad', m: 'addEntry', a: [id, entry] });
      return id;
    },
  };
}
