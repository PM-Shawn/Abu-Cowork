import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER,
  SIDECAR_CAPABILITIES,
  SIDECAR_PROTOCOL_VERSION,
  SidecarHandshakeError,
  parseSidecarHandshakeParams,
  parseSidecarHandshakeResult,
} from './sidecarProtocol';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return err instanceof SidecarHandshakeError ? err.code : `unexpected:${String(err)}`;
  }
  return undefined;
}

describe('sidecarProtocol', () => {
  it('is protocol 2 and lists the ledger-history capability', () => {
    expect(SIDECAR_PROTOCOL_VERSION).toBe(2);
    expect(SIDECAR_CAPABILITIES).toEqual([CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER]);
    expect(CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER).toBe('agent.start.history-from-ledger');
  });

  it('parses well-formed params and refuses everything else', () => {
    expect(parseSidecarHandshakeParams({ protocolVersion: 2, shellVersion: '0.51.0' }))
      .toEqual({ protocolVersion: 2, shellVersion: '0.51.0' });
    for (const bad of [null, [], 'x', {}, { protocolVersion: '2', shellVersion: 'v' }, { protocolVersion: 2 },
      { protocolVersion: 2, shellVersion: '' }, { protocolVersion: 2.5, shellVersion: 'v' },
      { protocolVersion: 2, shellVersion: 'v'.repeat(65) }]) {
      expect(codeOf(() => parseSidecarHandshakeParams(bad))).toBe('handshake_malformed');
    }
  });

  it('parses a well-formed result, keeping capabilities it does not know', () => {
    expect(parseSidecarHandshakeResult({ protocolVersion: 2, sidecarVersion: '0.51.0', capabilities: ['a', 'b'], extra: 1 }))
      .toEqual({ protocolVersion: 2, sidecarVersion: '0.51.0', capabilities: ['a', 'b'] });
  });

  it('tells a malformed result from an incompatible protocol', () => {
    for (const bad of [null, {}, { protocolVersion: 2, sidecarVersion: 'v' },
      { protocolVersion: 2, sidecarVersion: 'v', capabilities: 'a' },
      { protocolVersion: 2, sidecarVersion: 'v', capabilities: [1] },
      { protocolVersion: 2, sidecarVersion: '', capabilities: [] },
      { protocolVersion: 2, sidecarVersion: 'v', capabilities: Array.from({ length: 65 }, (_, i) => `c${i}`) }]) {
      expect(codeOf(() => parseSidecarHandshakeResult(bad))).toBe('handshake_malformed');
    }
    for (const version of [1, 3]) {
      expect(codeOf(() => parseSidecarHandshakeResult({ protocolVersion: version, sidecarVersion: 'v', capabilities: [] })))
        .toBe('protocol_incompatible');
    }
  });
});
