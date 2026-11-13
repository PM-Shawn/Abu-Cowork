import { describe, expect, it } from 'vitest';
import { parseCommandOutcome, parseFileReadOutcome, parseHttpFetchOutcome, outcomesAfterSpill } from './toolOutcomes';

describe('toolOutcomes', () => {
  describe('parseCommandOutcome', () => {
    it('keeps a whole record and drops unknown fields', () => {
      expect(
        parseCommandOutcome({ exitCode: 1, background: true, stdout: [8, 20], stderr: [30, 41], extra: 1 }),
      ).toEqual({ exitCode: 1, background: true, stdout: [8, 20], stderr: [30, 41] });
    });

    it('accepts an exit code alone', () => {
      expect(parseCommandOutcome({ exitCode: 0 })).toEqual({ exitCode: 0 });
    });

    it('accepts a negative exit code', () => {
      expect(parseCommandOutcome({ exitCode: -1, stderr: [8, 51] })).toEqual({ exitCode: -1, stderr: [8, 51] });
    });

    it.each([
      ['a missing exit code', { stdout: [0, 1] }],
      ['a fractional exit code', { exitCode: 1.5 }],
      ['a string exit code', { exitCode: '1' }],
      ['a reversed range', { exitCode: 0, stdout: [20, 8] }],
      ['a negative range start', { exitCode: 0, stdout: [-1, 2] }],
      ['a one-element range', { exitCode: 0, stdout: [1] }],
      ['background false', { exitCode: 0, background: false }],
      ['null', null],
      ['a string', 'text'],
    ])('returns undefined for %s', (_name, value) => {
      expect(parseCommandOutcome(value)).toBeUndefined();
    });
  });

  describe('parseFileReadOutcome', () => {
    it('keeps each kind', () => {
      expect(
        parseFileReadOutcome({ kind: 'text', startLine: 1, lineCount: 20, totalLines: 120, bodyStart: 42, extra: 'x' }),
      ).toEqual({ kind: 'text', startLine: 1, lineCount: 20, totalLines: 120, bodyStart: 42 });
      expect(parseFileReadOutcome({ kind: 'document' })).toEqual({ kind: 'document' });
      expect(parseFileReadOutcome({ kind: 'notice' })).toEqual({ kind: 'notice' });
    });

    it.each([
      ['an unknown kind', { kind: 'image' }],
      ['text without totalLines', { kind: 'text', startLine: 1, lineCount: 2, bodyStart: 0 }],
      ['a start line of 0', { kind: 'text', startLine: 0, lineCount: 2, totalLines: 2, bodyStart: 0 }],
      ['a negative line count', { kind: 'text', startLine: 1, lineCount: -1, totalLines: 2, bodyStart: 0 }],
      ['a fractional body start', { kind: 'text', startLine: 1, lineCount: 2, totalLines: 2, bodyStart: 2.5 }],
      ['an empty object', {}],
    ])('returns undefined for %s', (_name, value) => {
      expect(parseFileReadOutcome(value)).toBeUndefined();
    });
  });

  describe('parseHttpFetchOutcome', () => {
    it('keeps a whole record', () => {
      const record = { status: 200, statusText: 'OK', body: [13, 400], truncated: false };
      expect(parseHttpFetchOutcome(record)).toEqual(record);
    });

    it('keeps an empty status text', () => {
      const record = { status: 204, statusText: '', body: [13, 13], truncated: false };
      expect(parseHttpFetchOutcome(record)).toEqual(record);
    });

    it.each([
      ['a string status', { status: '200', statusText: 'OK', body: [13, 400], truncated: false }],
      ['a numeric status text', { status: 200, statusText: 1, body: [13, 400], truncated: false }],
      ['a reversed body range', { status: 200, statusText: 'OK', body: [400, 13], truncated: false }],
      ['a string truncated flag', { status: 200, statusText: 'OK', body: [13, 400], truncated: 'yes' }],
      ['a missing body', { status: 200, statusText: 'OK', truncated: false }],
    ])('returns undefined for %s', (_name, value) => {
      expect(parseHttpFetchOutcome(value)).toBeUndefined();
    });
  });
});

describe('outcomesAfterSpill', () => {
  it('drops the command sections and widens the http body to the stored text', () => {
    expect(outcomesAfterSpill({ commandOutcome: { exitCode: 0, stdout: [8, 900] } }, 'short')).toEqual({});
    expect(outcomesAfterSpill(
      { httpFetchOutcome: { status: 200, statusText: 'OK', body: [13, 90000], truncated: false } },
      'x'.repeat(4000),
    )).toEqual({ httpFetchOutcome: { status: 200, statusText: 'OK', body: [13, 4000], truncated: true } });
    expect(outcomesAfterSpill(undefined, 'x')).toBeUndefined();
  });
});
