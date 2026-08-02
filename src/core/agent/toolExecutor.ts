/**
 * Tool Executor — handles execution of tool call batches within the agent loop.
 *
 * Extracted from agentLoop.ts to reduce file size and improve modularity.
 * Responsibilities:
 * - Execute individual tools with abort support, hooks, and input validation
 * - Classify tool batches (computer / command / parallel) and execute accordingly
 * - Process results: update chatStore, eventRouter, and planned step tracking
 */

import type {
  ToolCall,
  ToolResultContent,
  ToolExecutionContext,
  ToolExecutionMetadata,
  ToolResult,
} from '../../types';
import type { ConfirmationInfo } from '../tools/commandSafety';
import type { FilePermissionCallback, ToolInvoker } from './ports/toolInvoker';
import { processToolResult } from '../session/sessionMemory';
import { evaluatePlanGate, getPlanMode } from './planMode';
import { emitHook } from './lifecycleHooks';
import type { PreToolCallEvent } from './lifecycleHooks';
import { setComputerUseBatchMode, setSkipAutoScreenshot } from '../tools/builtins';
import { setComputerUseActive, incrementComputerUseStep, setCurrentAction, isSessionWindowHidden, setSessionWindowHidden, pauseComputerUseStatus } from './computerUseStatus';
import { getI18n } from '../../i18n';
import { TOOL_NAMES } from '../tools/toolNames';
import { invoke } from '@tauri-apps/api/core';
import { getChatDelta } from './ports/chatDelta';
import { getConversationReader } from './ports/conversationReader';
import { setLoopContext, clearLoopContext } from './permissionBridge';
import type { EventRouter } from './eventRouter';
import { createLogger } from '../logging/logger';
import { startToolSpan } from '../observability/langfuse';
import { matchesToolPattern } from '../skill/toolFilter';

const logger = createLogger('toolExecutor');

/**
 * Result markers for tool calls that never actually executed. Written with
 * error:false (they are not model mistakes), so consumers that need to
 * distinguish "skipped" from "succeeded" must compare against these
 * constants — e.g. ShowWidgetCard renders a muted "cancelled" row instead
 * of mounting the widget. Pre-existing literal values kept verbatim (they
 * are persisted in conversation history).
 */
export const TOOL_RESULT_CANCELLED_MARKER = '[已取消]';
export const TOOL_RESULT_HOOK_BLOCKED_MARKER = '[被 hook 拦截]';

/** Human-readable description of a computer use action for the status bar. */
function actionToDescription(action: string, input: Record<string, unknown>): string {
  switch (action) {
    case 'screenshot': return '截屏';
    case 'click': return `点击 (${input.x}, ${input.y})`;
    case 'move': return `移动鼠标 (${input.x}, ${input.y})`;
    case 'scroll': return `滚动 ${input.direction}`;
    case 'drag': return `拖拽 (${input.startX},${input.startY}) → (${input.endX},${input.endY})`;
    case 'type': return `输入: ${(input.text as string)?.slice(0, 30) ?? ''}`;
    case 'key': return `按键: ${input.modifiers ? (input.modifiers as string[]).join('+') + '+' : ''}${input.key}`;
    case 'wait': return `等待 ${input.duration ?? 1000}ms`;
    default: return action;
  }
}

export interface ToolBatchParams {
  collectedToolCalls: ToolCall[];
  toolCallToStepId: Map<string, string>;
  conversationId: string;
  assistantMsgId: string;
  loopId: string;
  abortController: AbortController;
  eventRouter: EventRouter;
  executionId: string;
  inputValidators: Map<string, (input: Record<string, unknown>) => boolean>;
  /** Per-run execution denylist. This is an enforcement boundary, not only a
   * model-visible tool filter: hallucinated or malformed tool calls fail closed. */
  blockedTools?: string[];
  /** Per-run execution whitelist. Pattern matching follows skill allowedTools
   * semantics and is enforced before hooks or tool invocation. */
  allowedTools?: string[];
  confirmCb: (info: ConfirmationInfo) => Promise<boolean>;
  filePermCb: FilePermissionCallback;
  toolContext: ToolExecutionContext;
  /** ToolInvoker port instance, resolved once by the caller (agentLoop.ts)
   *  and threaded in — same discipline as the other resolve-once locals. */
  toolInvoker: ToolInvoker;
  /** Whether the loop will continue (tool_use stop reason) */
  continueLoop: boolean;
  /** Current context window usage (0-100). Scales tool result truncation under pressure. */
  contextUsagePercent?: number;
}

export interface ToolBatchResult {
  /** Whether MCP tools changed (server installed/uninstalled) */
  mcpChanged: boolean;
  /** A trusted tool requested an explicit user recovery choice. */
  requiresUserRecovery: boolean;
}

type ToolExecResult = {
  id: string;
  result: string;
  resultContent: ToolResultContent[] | undefined;
  error: boolean;
  duration: number;
  metadata?: ToolExecutionMetadata;
};

/**
 * Execute a batch of tool calls collected from the LLM response.
 *
 * Handles:
 * 1. Setting/clearing loop context for delegate_to_agent
 * 2. Single-tool execution with abort, hooks, and validation
 * 3. Batch classification: computer (sequential + window hide/show),
 *    run_command (sequential), or parallel
 * 4. Result processing: updating chatStore, eventRouter, and planned steps
 * 5. MCP tool change detection
 */
export async function executeToolBatch(params: ToolBatchParams): Promise<ToolBatchResult> {
  const {
    collectedToolCalls,
    toolCallToStepId,
    conversationId,
    assistantMsgId,
    loopId,
    abortController,
    eventRouter,
    inputValidators,
    confirmCb,
    filePermCb,
    toolContext,
    continueLoop,
    contextUsagePercent,
    toolInvoker,
  } = params;

  const chatDelta = getChatDelta();
  const blockedTools = new Set(params.blockedTools ?? []);
  const allowedTools = params.allowedTools ?? [];

  // Update the assistant message with tool calls
  chatDelta.setMessageToolCalls(conversationId, assistantMsgId, collectedToolCalls);

  // Execute tools in parallel using Promise.allSettled
  chatDelta.setAgentStatus('tool-calling', `${collectedToolCalls.length} tools`);

  // Expose loop context for delegate_to_agent tool (per-loop, supports concurrent agents)
  setLoopContext(loopId, {
    commandConfirmCallback: confirmCb,
    filePermissionCallback: filePermCb,
    signal: abortController.signal,
    eventRouter,
    loopId,
    conversationId,
    toolCallToStepId,
    blockedTools: params.blockedTools,
    allowedTools: params.allowedTools,
  });

  let completedCount = 0;
  const totalCount = collectedToolCalls.length;

  const executeSingleTool = async (tc: typeof collectedToolCalls[number]): Promise<ToolExecResult> => {
    if (allowedTools.length > 0 && !allowedTools.some((pattern) => matchesToolPattern(tc.name, pattern, tc.input))) {
      return {
        id: tc.id,
        result: `Error: tool "${tc.name}" is not allowed for this agent run`,
        resultContent: undefined,
        error: true,
        duration: 0,
      };
    }
    if (blockedTools.has(tc.name)) {
      return {
        id: tc.id,
        result: `Error: tool "${tc.name}" is blocked for this agent run`,
        resultContent: undefined,
        error: true,
        duration: 0,
      };
    }

    // Check if cancelled before executing
    if (abortController.signal.aborted) {
      return { id: tc.id, result: TOOL_RESULT_CANCELLED_MARKER, resultContent: undefined, error: false, duration: 0 };
    }

    // Emit preToolCall hook (can block or modify input)
    const preEvent = await emitHook({
      type: 'preToolCall' as const,
      timestamp: Date.now(),
      conversationId,
      toolName: tc.name,
      toolInput: tc.input,
      abortSignal: abortController.signal,
    } as PreToolCallEvent);

    if (preEvent.blocked) {
      // If the hook provided a reason, surface it as an error so the agent
      // can read why and adapt (e.g. switch from write_file to edit_file).
      // Without a reason, fall back to legacy generic message (error=false).
      if (preEvent.blockReason) {
        return { id: tc.id, result: preEvent.blockReason, resultContent: undefined, error: true, duration: 0 };
      }
      return { id: tc.id, result: TOOL_RESULT_HOOK_BLOCKED_MARKER, resultContent: undefined, error: false, duration: 0 };
    }

    // Plan mode gate: while a plan is pending approval ('planning'), block
    // mutating tools; read-only tools and report_plan/ask_user_question pass.
    // Read-only classification comes from planMode's explicit, security-reviewed
    // allowlist (READONLY_FALLBACK_TOOLS). We deliberately do NOT derive it from
    // isConcurrencySafe (a parallelism hint, not a security boundary), and
    // ToolDefinition has no readOnly field — so toolReadOnly stays undefined.
    const planGate = evaluatePlanGate({
      toolName: tc.name,
      toolReadOnly: undefined,
      planMode: getPlanMode(conversationId),
    });
    if (!planGate.allow) {
      return { id: tc.id, result: planGate.reason ?? '计划模式:已拦截写操作', resultContent: undefined, error: true, duration: 0 };
    }

    const effectiveInput = preEvent.modifiedInput ?? tc.input;

    // Enforce allowed-tools input constraints (e.g., run_command(npm *))
    const validator = inputValidators.get(tc.name);
    if (validator && !validator(effectiveInput)) {
      return { id: tc.id, result: `此操作被技能的 allowed-tools 限制拦截：工具 ${tc.name} 的输入不符合约束条件`, resultContent: undefined, error: true, duration: 0 };
    }

    const startTime = Date.now();
    let metadata: ToolExecutionMetadata | undefined;
    // Observability: record this tool execution as a span (no-op when disabled)
    const toolSpan = startToolSpan(conversationId, { name: tc.name, input: effectiveInput });
    try {
      // Race tool execution against abort signal so stop button works during long-running tools (e.g. MCP)
      const rawResult: ToolResult = await new Promise<ToolResult>((resolve, reject) => {
        if (abortController.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        let settled = false;
        const onAbort = () => {
          if (!settled) {
            settled = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
        toolInvoker.executeAnyTool(tc.name, effectiveInput, confirmCb, filePermCb, {
          ...toolContext,
          toolCallId: tc.id,
          abortSignal: abortController.signal,
          reportMetadata: (next) => {
            metadata = {
              ...metadata,
              ...next,
            };
          },
        }, contextUsagePercent)
          .then((result) => {
            if (!settled) {
              settled = true;
              abortController.signal.removeEventListener('abort', onAbort);
              resolve(result);
            }
          })
          .catch((err) => {
            if (!settled) {
              settled = true;
              abortController.signal.removeEventListener('abort', onAbort);
              reject(err);
            }
          });
      });
      const durationMs = Date.now() - startTime;
      completedCount++;
      if (totalCount > 1) {
        chatDelta.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
      }
      // Extract string for display/hooks; keep rich content for LLM
      const resultStr = toolInvoker.toolResultToString(rawResult);
      const resultContent: ToolResultContent[] | undefined =
        typeof rawResult !== 'string' ? rawResult : undefined;
      const requiresUserRecovery = Boolean(metadata?.sandboxRecovery);
      // Emit postToolCall hook
      await emitHook({
        type: 'postToolCall',
        timestamp: Date.now(),
        conversationId,
        toolName: tc.name,
        toolInput: effectiveInput,
        abortSignal: abortController.signal,
        result: resultStr,
        error: requiresUserRecovery,
        durationMs,
      });
      logger.info('Tool executed', { toolName: tc.name, durationMs, error: requiresUserRecovery });
      toolSpan.end({ output: resultStr });
      return {
        id: tc.id,
        result: resultStr,
        resultContent,
        error: requiresUserRecovery,
        duration: durationMs / 1000,
        metadata,
      };
    } catch (err) {
      // Re-throw AbortError so outer catch handles cancellation properly
      if (err instanceof Error && err.name === 'AbortError') {
        toolSpan.end({ output: '[aborted]', level: 'ERROR', statusMessage: 'aborted' });
        throw err;
      }
      const durationMs = Date.now() - startTime;
      completedCount++;
      if (totalCount > 1) {
        chatDelta.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Emit postToolCall hook for errors too
      await emitHook({
        type: 'postToolCall',
        timestamp: Date.now(),
        conversationId,
        toolName: tc.name,
        toolInput: effectiveInput,
        abortSignal: abortController.signal,
        result: `Error: ${errorMsg}`,
        error: true,
        durationMs,
      });
      logger.info('Tool executed', { toolName: tc.name, durationMs, error: true });
      toolSpan.end({ output: `Error: ${errorMsg}`, level: 'ERROR', statusMessage: errorMsg });
      return { id: tc.id, result: `Error: ${errorMsg}`, resultContent: undefined, error: true, duration: durationMs / 1000 };
    }
  };

  // If batch contains any computer tool call, execute ALL sequentially
  // (e.g. click → wait → type must run in order, not race each other)
  const hasComputerTool = collectedToolCalls.some(tc => tc.name === TOOL_NAMES.COMPUTER);

  const allRunCommand = collectedToolCalls.every(tc => tc.name === TOOL_NAMES.RUN_COMMAND);
  const strategy = hasComputerTool ? 'computer-sequential' : allRunCommand ? 'command-sequential' : 'parallel';
  logger.info('Tool batch started', { toolCount: collectedToolCalls.length, strategy });

  let results: PromiseSettledResult<ToolExecResult>[];
  if (hasComputerTool) {
    // Sequential execution for computer use batches.
    // Window hide is only needed when batch contains actions that physically interact
    // with the screen (click, type, etc.) — Abu's window may block the target.
    // Pure screenshot batches use capture_screen_excluding and don't need window hide.
    const ACTION_TYPES = new Set(['click', 'move', 'scroll', 'drag', 'type', 'key']);
    const hasInteractiveAction = collectedToolCalls.some(tc =>
      tc.name === TOOL_NAMES.COMPUTER && ACTION_TYPES.has(tc.input.action as string)
    );

    // Session-level window management: only hide on first interactive batch.
    // Subsequent batches in the same agent loop skip hide/show to avoid flickering.
    if (hasInteractiveAction && !isSessionWindowHidden()) {
      try { await invoke('show_screen_border', { stopLabel: getI18n().computerUse.stopControl }); } catch { /* ignore */ }
      try { await invoke('window_hide'); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 200));
      setSessionWindowHidden(true);
    }
    setComputerUseActive(true, conversationId);
    setComputerUseBatchMode(true);

    const sequentialResults: PromiseSettledResult<ToolExecResult>[] = [];
    try {
      for (let i = 0; i < collectedToolCalls.length; i++) {
        const tc = collectedToolCalls[i];
        // Only auto-screenshot on the last computer tool in the batch
        const hasMoreComputerTools = collectedToolCalls.slice(i + 1).some(t => t.name === TOOL_NAMES.COMPUTER);
        setSkipAutoScreenshot(tc.name === TOOL_NAMES.COMPUTER && hasMoreComputerTools);
        try {
          if (tc.name === TOOL_NAMES.COMPUTER) {
            const action = tc.input.action as string;
            setCurrentAction(actionToDescription(action, tc.input));
            incrementComputerUseStep(action);
          }
          const value = await executeSingleTool(tc);
          sequentialResults.push({ status: 'fulfilled', value });
        } catch (err) {
          sequentialResults.push({ status: 'rejected', reason: err });
        }
      }
    } finally {
      setSkipAutoScreenshot(false);
      setComputerUseBatchMode(false);
      // NOTE: window_show and hide_screen_border are NOT called here.
      // They are managed at session level — restored when the agent loop ends
      // (via cancelStreaming cleanup or natural loop completion).
      // This prevents window flickering between consecutive CU batches.
    }
    results = sequentialResults;
  } else {
    // Non-computer batch — pause the CU status bar if it was active from a
    // previous batch.  The session state (window hidden) is preserved so a
    // later computer batch can resume without flickering.
    pauseComputerUseStatus();

    // run_command may have implicit dependencies (e.g. npm install → npm build), serialize them
    if (allRunCommand) {
      const sequentialResults: PromiseSettledResult<ToolExecResult>[] = [];
      for (const tc of collectedToolCalls) {
        if (abortController.signal.aborted) break;
        try {
          const value = await executeSingleTool(tc);
          sequentialResults.push({ status: 'fulfilled', value });
        } catch (err) {
          sequentialResults.push({ status: 'rejected', reason: err });
        }
      }
      results = sequentialResults;
    } else {
      // Parallel execution for non-command batches
      const toolPromises = collectedToolCalls.map(tc => executeSingleTool(tc));
      results = await Promise.allSettled(toolPromises);
    }
  }

  // Update tool call results via EventRouter (use index to match rejected results)
  // Process results sequentially to handle async offloading
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const { id, result: toolResult, resultContent, error, metadata } = result.value;
      // Determine hideScreenshot for computer tool
      let hideScreenshot: boolean | undefined;
      const matchedTc = collectedToolCalls[i];
      if (matchedTc?.name === TOOL_NAMES.COMPUTER) {
        const showUser = matchedTc.input.show_user;
        const action = matchedTc.input.action as string;
        if (typeof showUser === 'boolean') {
          hideScreenshot = !showUser;
        } else {
          hideScreenshot = action !== 'screenshot';
        }
      }

      // Offload large tool results to disk to reduce localStorage pressure
      let storedResult = toolResult;
      try {
        const processed = await processToolResult(conversationId, id, toolResult);
        storedResult = processed.stored;
        if (processed.offloaded) {
          logger.info('Tool result offloaded to disk', { toolName: matchedTc?.name, originalSize: toolResult.length });
        }
      } catch {
        // Offload failed — store full result in memory (fallback)
      }

      // Snapshot any output files this tool produced so they survive original-file deletion.
      // Fire-and-forget: snapshot failures must never block the agent loop.
      // Uses the un-offloaded toolResult so extractFileOutputs can still parse stdout.
      if (!error && matchedTc) {
        const workspacePath = getConversationReader().getConversation(conversationId)?.workspacePath ?? null;
        import('../session/outputSnapshots').then(({ snapshotToolOutputs }) => {
          snapshotToolOutputs(conversationId, {
            id,
            name: matchedTc.name,
            input: matchedTc.input,
            result: toolResult,
          }, workspacePath).catch((e) => logger.warn('snapshot tool output failed', { tool: matchedTc.name, err: e }));
        }).catch(() => {});
      }

      chatDelta.updateToolCall(
        conversationId,
        assistantMsgId,
        id,
        storedResult,
        resultContent,
        error,
        hideScreenshot,
        metadata,
      );

      // Update TaskExecutionStore via EventRouter
      const stepId = toolCallToStepId.get(id);
      if (stepId) {
        if (error) {
          eventRouter.route({ type: 'step-error', loopId, stepId, error: toolResult });
        } else {
          eventRouter.route({ type: 'step-end', loopId, stepId, result: toolResult, resultContent });
        }
      }
    } else {
      // Use index to find the corresponding tool call
      const tc = collectedToolCalls[i];
      if (tc) {
        chatDelta.updateToolCall(conversationId, assistantMsgId, tc.id, `Error: ${result.reason}`, undefined, true);

        // Update TaskExecutionStore via EventRouter
        const stepId = toolCallToStepId.get(tc.id);
        if (stepId) {
          eventRouter.route({ type: 'step-error', loopId, stepId, error: String(result.reason) });
        }
      }
    }
  }

  // Clear loop context after tool execution
  clearLoopContext(loopId);

  // Detect tool changes (e.g. manage_mcp_server install)
  const mcpChanged = continueLoop && collectedToolCalls.some(tc =>
    tc.name === TOOL_NAMES.MANAGE_MCP_SERVER && (tc.input as Record<string, unknown>)?.action === 'install' ||
    tc.name === 'install_mcp_server' || tc.name === 'uninstall_mcp_server'
  );
  const requiresUserRecovery = results.some(
    (result) => result.status === 'fulfilled' && Boolean(result.value.metadata?.sandboxRecovery),
  );

  return { mcpChanged, requiresUserRecovery };
}
