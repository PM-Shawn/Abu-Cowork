import { describe, expect, it } from 'vitest';
import { AGENT_START_PROTOCOL_ENV, handleHandshake, sidecarCapabilitiesFor } from './handshake';

const LEDGER_HISTORY = 'agent.start.history-from-ledger';
const REQUEST = { protocolVersion: 2, shellVersion: 'test' };

describe('sidecar capabilities and ABU_AGENT_START_PROTOCOL', () => {
  it('names the variable', () => {
    expect(AGENT_START_PROTOCOL_ENV).toBe('ABU_AGENT_START_PROTOCOL');
  });

  it('announces the ledger-history capability unless the variable is exactly 1', () => {
    expect(sidecarCapabilitiesFor({})).toEqual([LEDGER_HISTORY]);
    for (const value of [undefined, '', '2', '0', 'v1', ' 1', '1 ', 'true']) {
      expect(sidecarCapabilitiesFor({ ABU_AGENT_START_PROTOCOL: value })).toEqual([LEDGER_HISTORY]);
    }
    expect(sidecarCapabilitiesFor({ ABU_AGENT_START_PROTOCOL: '1' })).toEqual([]);
  });

  it('the handshake answer follows the environment the process was started with', () => {
    expect(handleHandshake(REQUEST, {}).capabilities).toEqual([LEDGER_HISTORY]);
    const switched = handleHandshake(REQUEST, { ABU_AGENT_START_PROTOCOL: '1' });
    expect(switched.capabilities).toEqual([]);
    // The protocol version is the same either way; only the announced list differs.
    expect(switched.protocolVersion).toBe(2);
  });

  it('returns a fresh list each time', () => {
    const first = sidecarCapabilitiesFor({});
    first.push('mutated');
    expect(sidecarCapabilitiesFor({})).toEqual([LEDGER_HISTORY]);
  });
});
