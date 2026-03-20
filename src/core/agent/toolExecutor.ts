/**
 * Tool Executor — handles execution of tool call batches within the agent loop.
 *
 * Extracted from agentLoop.ts to reduce file size and improve modularity.
 * Responsibilities:
 * - Execute individual tools with abort support, hooks, and input validation
 * - Classify tool batches (computer / command / parallel) and execute accordingly
 * - Process results: update chatStore, eventRouter, and planned step tracking
 */

import type { ToolCall, ToolResultContent, ToolExecutionContext, ToolResult } from '../../types';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { executeAnyTool, toolResultToString } from '../tools/registry';
import { emitHook } from './lifecycleHooks';
import type { PreToolCallEvent } from './lifecycleHooks';
import { setComputerUseBatchMode, setSkipAutoScreenshot } from '../tools/builtins';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore } from '../../stores/chatStore';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { setCurrentLoopContext } from './permissionBridge';
import type { EventRouter } from './eventRouter';

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
  confirmCb: (info: ConfirmationInfo) => Promise<boolean>;
  filePermCb: FilePermissionCallback;
  toolContext: ToolExecutionContext;
  /** Whether the loop will continue (tool_use stop reason) */
  continueLoop: boolean;
}

export interface ToolBatchResult {
  /** Whether MCP tools changed (server installed/uninstalled) */
  mcpChanged: boolean;
}

type ToolExecResult = {
  id: string;
  result: string;
  resultContent: ToolResultContent[] | undefined;
  error: boolean;
  duration: number;
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
    executionId,
    inputValidators,
    confirmCb,
    filePermCb,
    toolContext,
    continueLoop,
  } = params;

  const chatStore = useChatStore.getState();

  // Update the assistant message with tool calls
  useChatStore.setState((state) => {
    const msg = state.conversations[conversationId]?.messages.find(
      (m) => m.id === assistantMsgId
    );
    if (msg) {
      msg.toolCalls = collectedToolCalls;
      msg.isStreaming = false;
    }
  });

  // Execute tools in parallel using Promise.allSettled
  chatStore.setAgentStatus('tool-calling', `${collectedToolCalls.length} tools`);

  // Expose loop context for delegate_to_agent tool
  setCurrentLoopContext({
    commandConfirmCallback: confirmCb,
    filePermissionCallback: filePermCb,
    signal: abortController.signal,
    eventRouter,
    loopId,
    conversationId,
    toolCallToStepId,
  });

  let completedCount = 0;
  const totalCount = collectedToolCalls.length;

  const executeSingleTool = async (tc: typeof collectedToolCalls[number]): Promise<ToolExecResult> => {
    // Check if cancelled before executing
    if (abortController.signal.aborted) {
      return { id: tc.id, result: '[已取消]', resultContent: undefined, error: false, duration: 0 };
    }

    // Emit preToolCall hook (can block or modify input)
    const preEvent = await emitHook({
      type: 'preToolCall' as const,
      timestamp: Date.now(),
      conversationId,
      toolName: tc.name,
      toolInput: tc.input,
    } as PreToolCallEvent);

    if (preEvent.blocked) {
      return { id: tc.id, result: '[被 hook 拦截]', resultContent: undefined, error: false, duration: 0 };
    }

    const effectiveInput = preEvent.modifiedInput ?? tc.input;

    // Enforce allowed-tools input constraints (e.g., run_command(npm *))
    const validator = inputValidators.get(tc.name);
    if (validator && !validator(effectiveInput)) {
      return { id: tc.id, result: `此操作被技能的 allowed-tools 限制拦截：工具 ${tc.name} 的输入不符合约束条件`, resultContent: undefined, error: true, duration: 0 };
    }

    const startTime = Date.now();
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
        executeAnyTool(tc.name, effectiveInput, confirmCb, filePermCb, toolContext)
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
        chatStore.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
      }
      // Extract string for display/hooks; keep rich content for LLM
      const resultStr = toolResultToString(rawResult);
      const resultContent: ToolResultContent[] | undefined =
        typeof rawResult !== 'string' ? rawResult : undefined;
      // Emit postToolCall hook
      await emitHook({
        type: 'postToolCall',
        timestamp: Date.now(),
        conversationId,
        toolName: tc.name,
        toolInput: effectiveInput,
        result: resultStr,
        error: false,
        durationMs,
      });
      return { id: tc.id, result: resultStr, resultContent, error: false, duration: durationMs / 1000 };
    } catch (err) {
      // Re-throw AbortError so outer catch handles cancellation properly
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      const durationMs = Date.now() - startTime;
      completedCount++;
      if (totalCount > 1) {
        chatStore.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Emit postToolCall hook for errors too
      await emitHook({
        type: 'postToolCall',
        timestamp: Date.now(),
        conversationId,
        toolName: tc.name,
        toolInput: effectiveInput,
        result: `Error: ${errorMsg}`,
        error: true,
        durationMs,
      });
      return { id: tc.id, result: `Error: ${errorMsg}`, resultContent: undefined, error: true, duration: durationMs / 1000 };
    }
  };

  // If batch contains any computer tool call, execute ALL sequentially
  // (e.g. click → wait → type must run in order, not race each other)
  const hasComputerTool = collectedToolCalls.some(tc => tc.name === 'computer');

  let results: PromiseSettledResult<ToolExecResult>[];
  if (hasComputerTool) {
    // Sequential execution for computer use batches
    // Batch-level window management: hide once before, show once after
    try { await invoke('window_hide'); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 200));
    setComputerUseBatchMode(true);

    const sequentialResults: PromiseSettledResult<ToolExecResult>[] = [];
    try {
      for (let i = 0; i < collectedToolCalls.length; i++) {
        const tc = collectedToolCalls[i];
        // Only auto-screenshot on the last computer tool in the batch
        const hasMoreComputerTools = collectedToolCalls.slice(i + 1).some(t => t.name === 'computer');
        setSkipAutoScreenshot(tc.name === 'computer' && hasMoreComputerTools);
        try {
          const value = await executeSingleTool(tc);
          sequentialResults.push({ status: 'fulfilled', value });
        } catch (err) {
          sequentialResults.push({ status: 'rejected', reason: err });
        }
      }
    } finally {
      setSkipAutoScreenshot(false);
      setComputerUseBatchMode(false);
      try { await invoke('window_show'); } catch { /* ignore */ }
    }
    results = sequentialResults;
  } else {
    // run_command may have implicit dependencies (e.g. npm install → npm build), serialize them
    const allRunCommand = collectedToolCalls.every(tc => tc.name === 'run_command');
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
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      const { id, result: toolResult, resultContent, error } = result.value;
      // Determine hideScreenshot for computer tool
      let hideScreenshot: boolean | undefined;
      const matchedTc = collectedToolCalls[i];
      if (matchedTc?.name === 'computer') {
        const showUser = matchedTc.input.show_user;
        const action = matchedTc.input.action as string;
        if (typeof showUser === 'boolean') {
          hideScreenshot = !showUser;
        } else {
          hideScreenshot = action !== 'screenshot';
        }
      }
      chatStore.updateToolCall(conversationId, assistantMsgId, id, toolResult, resultContent, error, hideScreenshot);

      // Update TaskExecutionStore via EventRouter
      const stepId = toolCallToStepId.get(id);
      if (stepId) {
        if (error) {
          eventRouter.route({ type: 'step-error', loopId, stepId, error: toolResult });
        } else {
          eventRouter.route({ type: 'step-end', loopId, stepId, result: toolResult, resultContent });
        }

        // Update linked planned step status and auto-advance to next
        const execState = useTaskExecutionStore.getState().executions[executionId];
        if (execState) {
          const linkedPlanned = execState.plannedSteps.find(s => s.linkedStepId === stepId);
          if (linkedPlanned) {
            useTaskExecutionStore.getState().updatePlannedStepStatus(
              executionId,
              linkedPlanned.index,
              error ? 'error' : 'completed'
            );
            // Auto-advance: link the next pending planned step to the next
            // tool call's execution step (using collectedToolCalls index for reliability)
            const nextPending = useTaskExecutionStore.getState().executions[executionId]
              ?.plannedSteps.find(s => s.status === 'pending');
            if (nextPending) {
              for (let j = i + 1; j < collectedToolCalls.length; j++) {
                const nextStepId = toolCallToStepId.get(collectedToolCalls[j].id);
                if (nextStepId) {
                  useTaskExecutionStore.getState().linkPlannedStep(executionId, nextPending.index, nextStepId);
                  useTaskExecutionStore.getState().updatePlannedStepStatus(executionId, nextPending.index, 'running');
                  break;
                }
              }
            }
          }
        }
      }
    } else {
      // Use index to find the corresponding tool call
      const tc = collectedToolCalls[i];
      if (tc) {
        chatStore.updateToolCall(conversationId, assistantMsgId, tc.id, `Error: ${result.reason}`, undefined, true);

        // Update TaskExecutionStore via EventRouter
        const stepId = toolCallToStepId.get(tc.id);
        if (stepId) {
          eventRouter.route({ type: 'step-error', loopId, stepId, error: String(result.reason) });

          // Update linked planned step status
          const execState = useTaskExecutionStore.getState().executions[executionId];
          if (execState) {
            const linkedPlanned = execState.plannedSteps.find(s => s.linkedStepId === stepId);
            if (linkedPlanned) {
              useTaskExecutionStore.getState().updatePlannedStepStatus(
                executionId,
                linkedPlanned.index,
                'error'
              );
            }
          }
        }
      }
    }
  });

  // Clear loop context after tool execution
  setCurrentLoopContext(null);

  // Detect tool changes (e.g. manage_mcp_server install)
  const mcpChanged = continueLoop && collectedToolCalls.some(tc =>
    tc.name === 'manage_mcp_server' && (tc.input as Record<string, unknown>)?.action === 'install' ||
    tc.name === 'install_mcp_server' || tc.name === 'uninstall_mcp_server'
  );

  return { mcpChanged };
}
