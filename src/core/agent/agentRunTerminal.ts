import type { AgentLoopExitReason, AgentLoopResult } from './agentLoop';
import type { UpstreamErrorDetails } from '../../types';
import {
  isUpstreamErrorDetails,
  isUnsafeStructuredLlmErrorText,
  normalizeUpstreamErrorDetails,
  sanitizeUntrustedLlmErrorText,
} from '../llm/adapter';

export const AGENT_RUN_TERMINAL_VERSION = 1 as const;

export type AgentRunTerminalState = 'completed' | 'failed' | 'interrupted';

export interface AgentRunTerminalFailure {
  errorType: string;
  message: string;
  stack?: string;
  upstream?: UpstreamErrorDetails;
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
const AGENT_RUN_TERMINAL_KEYS = new Set(['version', 'runId', 'state', 'result', 'failure']);
const AGENT_LOOP_RESULT_KEYS = new Set(['reason', 'error', 'stopReason', 'messageTaken', 'upstream']);
const AGENT_RUN_TERMINAL_FAILURE_KEYS = new Set(['errorType', 'message', 'stack', 'upstream']);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

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
  const upstream = normalizeUpstreamErrorDetails(result.upstream);
  const projectedResult: AgentLoopResult = {
    reason: result.reason,
    ...(result.reason === 'error' && result.error !== undefined ? { error: result.error } : {}),
    ...(result.reason === 'error' && result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
    ...(result.reason === 'error' ? { messageTaken: result.messageTaken } : {}),
    ...(result.reason === 'error' && upstream ? { upstream } : {}),
  } as AgentLoopResult;
  const state = terminalStateForAgentLoopResult(projectedResult);
  const sourceFailure = state === 'failed'
    ? failure ?? {
        errorType: 'agent_loop_error',
        message: projectedResult.error || 'Agent run failed',
        ...(upstream ? { upstream } : {}),
      }
    : undefined;
  const failureUpstream = normalizeUpstreamErrorDetails(sourceFailure?.upstream);
  const resolvedFailure = state === 'failed'
    && sourceFailure
    ? {
        errorType: sourceFailure.errorType,
        message: sourceFailure.message,
        ...(sourceFailure.stack !== undefined ? { stack: sourceFailure.stack } : {}),
        ...(failureUpstream ? { upstream: failureUpstream } : {}),
      }
    : undefined;
  return {
    version: AGENT_RUN_TERMINAL_VERSION,
    runId,
    state,
    result: projectedResult,
    ...(resolvedFailure ? { failure: resolvedFailure } : {}),
  };
}

function areUpstreamErrorsEqual(left?: UpstreamErrorDetails, right?: UpstreamErrorDetails): boolean {
  return left?.status === right?.status
    && left?.error_type === right?.error_type
    && left?.traceId === right?.traceId
    && left?.summary === right?.summary;
}

export function isAgentRunTerminal(value: unknown): value is AgentRunTerminal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!hasOnlyKeys(candidate, AGENT_RUN_TERMINAL_KEYS)) return false;
  if (candidate.version !== AGENT_RUN_TERMINAL_VERSION) return false;
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return false;
  if (candidate.state !== 'completed' && candidate.state !== 'failed' && candidate.state !== 'interrupted') return false;
  if (typeof candidate.result !== 'object' || candidate.result === null) return false;

  const result = candidate.result as Record<string, unknown>;
  if (!hasOnlyKeys(result, AGENT_LOOP_RESULT_KEYS)) return false;
  if (typeof result.reason !== 'string' || !AGENT_LOOP_EXIT_REASONS.has(result.reason as AgentLoopExitReason)) return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;
  if (result.stopReason !== undefined && result.stopReason !== 'sidecar_unavailable') return false;
  if (result.reason !== 'error' && result.stopReason !== undefined) return false;
  if (result.reason !== 'error' && result.error !== undefined) return false;
  if (result.messageTaken !== undefined && typeof result.messageTaken !== 'boolean') return false;
  if (result.reason === 'error' && typeof result.messageTaken !== 'boolean') return false;
  if (result.reason !== 'error' && result.messageTaken !== undefined) return false;
  if (result.reason !== 'error' && result.upstream !== undefined) return false;
  if (result.upstream !== undefined && !isUpstreamErrorDetails(result.upstream)) return false;

  if (candidate.state !== terminalStateForAgentLoopResult(result as unknown as AgentLoopResult)) return false;
  if (candidate.state !== 'failed') return candidate.failure === undefined;
  if (typeof candidate.failure !== 'object' || candidate.failure === null) return false;
  const failure = candidate.failure as Record<string, unknown>;
  if (!hasOnlyKeys(failure, AGENT_RUN_TERMINAL_FAILURE_KEYS)) return false;
  const failureIsValid = typeof failure.errorType === 'string'
    && failure.errorType.length > 0
    && typeof failure.message === 'string'
    && (failure.stack === undefined || typeof failure.stack === 'string')
    && (failure.upstream === undefined || isUpstreamErrorDetails(failure.upstream));
  if (!failureIsValid) return false;
  if (result.upstream !== undefined && failure.upstream !== undefined) {
    return areUpstreamErrorsEqual(
      result.upstream as UpstreamErrorDetails,
      failure.upstream as UpstreamErrorDetails,
    );
  }
  return true;
}

/**
 * Renderer-side compatibility projection for terminals emitted before the
 * bounded upstream contract existed. Matched-version senders already provide
 * safe text; legacy JSON/HTML bodies degrade to a generic message here.
 */
export function sanitizeReceivedAgentRunTerminal(
  terminal: AgentRunTerminal,
  fallbackMessage: string,
): AgentRunTerminal {
  if (terminal.state !== 'failed') return terminal;
  const { upstream: _resultUpstream, ...resultWithoutUpstream } = terminal.result;
  const resultUpstream = normalizeUpstreamErrorDetails(terminal.result.upstream);
  const error = sanitizeUntrustedLlmErrorText(terminal.result.error, fallbackMessage);
  let failure: AgentRunTerminalFailure | undefined;
  if (terminal.failure) {
    const { upstream: _failureUpstream, stack, ...failureWithoutUpstreamOrStack } = terminal.failure;
    const failureUpstream = normalizeUpstreamErrorDetails(terminal.failure.upstream);
    failure = {
      ...failureWithoutUpstreamOrStack,
      message: sanitizeUntrustedLlmErrorText(terminal.failure.message, error),
      ...(stack && !isUnsafeStructuredLlmErrorText(stack) ? { stack } : {}),
      ...(failureUpstream ? { upstream: failureUpstream } : {}),
    };
  }
  return {
    ...terminal,
    result: {
      ...resultWithoutUpstream,
      error,
      ...(resultUpstream ? { upstream: resultUpstream } : {}),
    },
    ...(failure ? { failure } : {}),
  };
}

export function areAgentRunTerminalsEqual(left: AgentRunTerminal, right: AgentRunTerminal): boolean {
  return left.version === right.version
    && left.runId === right.runId
    && left.state === right.state
    && left.result.reason === right.result.reason
    && left.result.error === right.result.error
    && (left.result.reason === 'error' ? left.result.messageTaken : undefined)
      === (right.result.reason === 'error' ? right.result.messageTaken : undefined)
    && left.result.stopReason === right.result.stopReason
    && areUpstreamErrorsEqual(left.result.upstream, right.result.upstream)
    && left.failure?.errorType === right.failure?.errorType
    && left.failure?.message === right.failure?.message
    && left.failure?.stack === right.failure?.stack
    && areUpstreamErrorsEqual(left.failure?.upstream, right.failure?.upstream);
}
