import { describe, expect, it } from 'vitest';
import { HANDSHAKE_RESULT_CONTRACT_FIXTURE } from './__contractFixtures__/handshakeFixture';
import { CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER, parseSidecarHandshakeResult } from './sidecarProtocol';

describe('handshake wire contract — shell', () => {
  it('accepts the shared result as it arrives off the wire', () => {
    const parsed = parseSidecarHandshakeResult(JSON.parse(JSON.stringify(HANDSHAKE_RESULT_CONTRACT_FIXTURE)));
    expect(parsed).toEqual(HANDSHAKE_RESULT_CONTRACT_FIXTURE);
    expect(parsed.capabilities).toContain(CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER);
  });
});
