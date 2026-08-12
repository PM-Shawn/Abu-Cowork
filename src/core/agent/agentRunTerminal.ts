import type { AgentLoopExitReason, AgentLoopResult } from './agentLoop';

export const AGENT_RUN_TERMINAL_VERSION = 1 as const;

export type AgentRunTerminalState = 'completed' | 'failed' | 'interrupted';

export interface AgentRunTerminalFailure {
  errorType: string;
  message: string;
  stack?: string;
}

/**
 * Ordered, idempotent terminal fact for one sidecar-hosted agent run.
 *
 * The sidecar emits this only after flushing its final `agent.delta` batch
 * and before settling the `agent.run` RPC. The shell therefore has an
 * authoritative outcome even when the RPC response is lost after the work
 * and UI frames have already completed.
 */
export interface AgentRunTerminal {
  version: typeof AGENT_RUN_TERMINAL_VERSION;
  runId: string;
  state: AgentRunTerminalState;
  result: AgentLoopResult;
  failure?: AgentRunTerminalFailure;
}

const AGENT_LOOP_EXIT_REASONS = new Set<AgentLoopExitReason>([
  'completed',
  'aborted',
  'error',
  'max_turns',
  'no_progress',
  'awaiting_user',
  'enqueued',
]);

export function terminalStateForAgentLoopResult(result: AgentLoopResult): AgentRunTerminalState {
  if (result.reason === 'error') return 'failed';
  if (result.reason === 'aborted') return 'interrupted';
  return 'completed';
}

export function createAgentRunTerminal(
  runId: string,
  result: AgentLoopResult,
  failure?: AgentRunTerminalFailure,
): AgentRunTerminal {
  const state = terminalStateForAgentLoopResult(result);
  return {
    version: AGENT_RUN_TERMINAL_VERSION,
    runId,
    state,
    result,
    ...(state === 'failed' ? {
      failure: failure ?? {
        errorType: 'agent_loop_error',
        message: result.error || 'Agent run failed',
      },
    } : {}),
  };
}

export function isAgentRunTerminal(value: unknown): value is AgentRunTerminal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== AGENT_RUN_TERMINAL_VERSION) return false;
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return false;
  if (candidate.state !== 'completed' && candidate.state !== 'failed' && candidate.state !== 'interrupted') return false;
  if (typeof candidate.result !== 'object' || candidate.result === null) return false;

  const result = candidate.result as Record<string, unknown>;
  if (typeof result.reason !== 'string' || !AGENT_LOOP_EXIT_REASONS.has(result.reason as AgentLoopExitReason)) return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;

  if (candidate.state !== terminalStateForAgentLoopResult(result as unknown as AgentLoopResult)) return false;
  if (candidate.state !== 'failed') return candidate.failure === undefined;
  if (typeof candidate.failure !== 'object' || candidate.failure === null) return false;
  const failure = candidate.failure as Record<string, unknown>;
  return typeof failure.errorType === 'string'
    && failure.errorType.length > 0
    && typeof failure.message === 'string'
    && (failure.stack === undefined || typeof failure.stack === 'string');
}

export function areAgentRunTerminalsEqual(left: AgentRunTerminal, right: AgentRunTerminal): boolean {
  return left.version === right.version
    && left.runId === right.runId
    && left.state === right.state
    && left.result.reason === right.result.reason
    && left.result.error === right.result.error
    && left.failure?.errorType === right.failure?.errorType
    && left.failure?.message === right.failure?.message
    && left.failure?.stack === right.failure?.stack;
}
