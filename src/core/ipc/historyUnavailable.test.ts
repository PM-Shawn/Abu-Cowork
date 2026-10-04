import { describe, expect, it } from 'vitest';
import { HISTORY_UNAVAILABLE_CONTRACT_FIXTURE } from './__contractFixtures__/historyUnavailableFixture';
import {
  HISTORY_UNAVAILABLE_RPC_CODE,
  historyUnavailableData,
  parseHistoryUnavailableError,
} from './historyUnavailable';

describe('historyUnavailable', () => {
  it('builds the shared payload', () => {
    expect(historyUnavailableData('watermark_beyond_file', 4096, 1024)).toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
    expect(HISTORY_UNAVAILABLE_RPC_CODE).toBe(-32010);
  });

  it('carries numbers and fixed vocabulary only', () => {
    for (const reason of ['watermark_beyond_file', 'watermark_not_at_line_end', 'ledger_unreadable', 'current_turn_missing'] as const) {
      const data = historyUnavailableData(reason, 0, 0);
      expect(Object.keys(data).sort()).toEqual(['code', 'fileBytes', 'reason', 'uptoBytes']);
      expect(parseHistoryUnavailableError({ code: HISTORY_UNAVAILABLE_RPC_CODE, data })).toEqual(data);
    }
  });

  it('reads the payload from an error object and from the same object after a JSON round trip', () => {
    const rejected = Object.assign(new Error('Sidecar error -32010: history_unavailable'), {
      code: -32010,
      data: HISTORY_UNAVAILABLE_CONTRACT_FIXTURE,
    });
    expect(parseHistoryUnavailableError(rejected)).toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
    expect(parseHistoryUnavailableError(JSON.parse(JSON.stringify({ code: -32010, data: HISTORY_UNAVAILABLE_CONTRACT_FIXTURE }))))
      .toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
  });

  it('is null for every other error', () => {
    const data = HISTORY_UNAVAILABLE_CONTRACT_FIXTURE;
    for (const other of [
      null,
      'history_unavailable',
      new Error('history_unavailable'),
      { code: -32603, data },
      { code: -32010 },
      { code: -32010, data: null },
      { code: '-32010', data },
      { code: -32010, data: { ...data, code: 'payload_too_large' } },
      { code: -32010, data: { ...data, reason: 'because' } },
      { code: -32010, data: { ...data, uptoBytes: -1 } },
      { code: -32010, data: { ...data, fileBytes: 1.5 } },
      { code: -32010, data: { ...data, uptoBytes: '4096' } },
      { code: -32010, data: { ...data, fileBytes: Number.NaN } },
    ]) {
      expect(parseHistoryUnavailableError(other)).toBeNull();
    }
  });
});
