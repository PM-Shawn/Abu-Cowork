import { describe, expect, it } from 'vitest';
import { FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE } from '@/core/agent/__contractFixtures__/agentRunTerminalFixture';
import { createAgentRunTerminal } from '@/core/agent/agentRunTerminal';

describe('agent.terminal wire contract — sender', () => {
  it('projects the shared upstream fields into the failed terminal without renaming or dropping them', () => {
    const terminal = createAgentRunTerminal(
      FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.runId,
      FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE.result,
    );

    expect(terminal).toEqual(FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE);
    expect(JSON.parse(JSON.stringify(terminal))).toEqual(FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE);
  });

  it('drops a privacy-unsafe upstream object at the sender boundary', () => {
    const terminal = createAgentRunTerminal('unsafe-terminal-run', {
      reason: 'error',
      error: 'HTTP 403 · content_policy',
      messageTaken: true,
      upstream: {
        status: 403,
        rawBody: 'private prompt text',
      } as never,
    });

    expect(terminal.result.upstream).toBeUndefined();
    expect(terminal.failure?.upstream).toBeUndefined();
    expect(JSON.stringify(terminal)).not.toContain('rawBody');
    expect(JSON.stringify(terminal)).not.toContain('private prompt text');
  });
});
