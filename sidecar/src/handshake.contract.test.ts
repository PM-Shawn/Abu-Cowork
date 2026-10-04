import { describe, expect, it } from 'vitest';
import {
  HANDSHAKE_REQUEST_CONTRACT_FIXTURE,
  HANDSHAKE_RESULT_CONTRACT_FIXTURE,
} from '@/core/sidecar/__contractFixtures__/handshakeFixture';
import { RpcError } from './protocol';
import { handleHandshake } from './handshake';

describe('handshake wire contract — sidecar', () => {
  it('answers the shared request with the shared result, unchanged by a JSON round trip', () => {
    const result = handleHandshake(JSON.parse(JSON.stringify(HANDSHAKE_REQUEST_CONTRACT_FIXTURE)), {});
    expect(result).toEqual(HANDSHAKE_RESULT_CONTRACT_FIXTURE);
    expect(JSON.parse(JSON.stringify(result))).toEqual(HANDSHAKE_RESULT_CONTRACT_FIXTURE);
  });

  it('answers a shell on another protocol version with its own version; the shell decides', () => {
    expect(handleHandshake({ protocolVersion: 9, shellVersion: '9.0.0' }, {}).protocolVersion).toBe(2);
  });

  it('refuses malformed params as invalid params', () => {
    let thrown: unknown;
    try {
      handleHandshake({ shellVersion: 'x' }, {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe(-32602);
  });
});
