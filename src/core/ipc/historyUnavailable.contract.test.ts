// @vitest-environment node
/**
 * The receiving half of the `history_unavailable` contract: the sidecar's
 * rejected `agent.start` line (pinned against the same fixture in
 * `sidecar/src/agentStartHistory.contract.test.ts`) becomes the rejection
 * `request()` hands the dispatcher, and the shell's parser reads it back.
 */
import { describe, expect, it } from 'vitest';
import { SidecarRpcError } from '@/core/sidecar/sidecarManager';
import { HISTORY_UNAVAILABLE_CONTRACT_FIXTURE } from './__contractFixtures__/historyUnavailableFixture';
import { HISTORY_UNAVAILABLE_RPC_CODE, parseHistoryUnavailableError } from './historyUnavailable';

describe('history_unavailable wire contract — shell', () => {
  it('recognises the rejection `request()` produces from the shared payload', () => {
    const wire = JSON.parse(JSON.stringify({
      code: HISTORY_UNAVAILABLE_RPC_CODE,
      message: 'history_unavailable',
      data: HISTORY_UNAVAILABLE_CONTRACT_FIXTURE,
    })) as { code: number; message: string; data: unknown };
    const rejection = new SidecarRpcError(wire.code, wire.message, wire.data);

    expect(parseHistoryUnavailableError(rejection)).toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
  });

  it('leaves any other sidecar rejection to the generic transport handling', () => {
    expect(parseHistoryUnavailableError(new SidecarRpcError(-32603, 'Internal error', { message: 'boom' }))).toBeNull();
  });
});
