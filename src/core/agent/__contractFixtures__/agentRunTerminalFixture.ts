import type { AgentRunTerminal } from '../agentRunTerminal';

export const UPSTREAM_ERROR_CONTRACT_FIXTURE = {
  status: 403,
  error_type: 'governance.alicloud_content_safety_input_rejected',
  traceId: 'contract-trace-403',
  summary: 'The upstream content safety system rejected the request.',
} as const;

export const FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE = {
  version: 1,
  runId: 'run-upstream-contract',
  state: 'failed',
  result: {
    reason: 'error',
    error: 'The upstream content safety system rejected the request.',
    messageTaken: true,
    upstream: UPSTREAM_ERROR_CONTRACT_FIXTURE,
  },
  failure: {
    errorType: 'agent_loop_error',
    message: 'The upstream content safety system rejected the request.',
    upstream: UPSTREAM_ERROR_CONTRACT_FIXTURE,
  },
} as const satisfies AgentRunTerminal;
