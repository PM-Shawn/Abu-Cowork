import { describe, it, expect } from 'vitest';
import { resolveQuarantineAsOf } from './quarantineAsOf';

describe('resolveQuarantineAsOf', () => {
  it('uses QUARANTINE_ASOF from env when present and well-formed', () => {
    const d = resolveQuarantineAsOf({ QUARANTINE_ASOF: '2026-09-02' }, '2026-01-01');
    expect(d.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('falls back to the committed constant when env is absent', () => {
    const d = resolveQuarantineAsOf({}, '2026-01-01');
    expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats an empty env value as absent', () => {
    const d = resolveQuarantineAsOf({ QUARANTINE_ASOF: '' }, '2026-01-01');
    expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws on a malformed env value instead of silently falling back', () => {
    expect(() => resolveQuarantineAsOf({ QUARANTINE_ASOF: '09/02/2026' }, '2026-01-01')).toThrow(
      'QUARANTINE_ASOF must be YYYY-MM-DD, got "09/02/2026"',
    );
  });

  it('throws on an impossible calendar date', () => {
    expect(() => resolveQuarantineAsOf({ QUARANTINE_ASOF: '2026-13-40' }, '2026-01-01')).toThrow(
      'QUARANTINE_ASOF must be YYYY-MM-DD, got "2026-13-40"',
    );
  });
});
