import { describe, expect, it } from 'vitest';
import { FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE } from './__contractFixtures__/agentRunTerminalFixture';
import { isAgentRunTerminal } from './agentRunTerminal';

describe('agent.terminal wire contract — receiver', () => {
  it('accepts the shared failed-terminal fixture after an NDJSON-compatible round trip', () => {
    const wireValue: unknown = JSON.parse(JSON.stringify(FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE));

    expect(isAgentRunTerminal(wireValue)).toBe(true);
    expect(wireValue).toEqual(FAILED_AGENT_TERMINAL_CONTRACT_FIXTURE);
  });
});
