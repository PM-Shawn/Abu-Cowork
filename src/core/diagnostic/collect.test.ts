import { describe, it, expect } from 'vitest';
import { capDiagnosticMessages, DEFAULT_DIAGNOSTIC_MESSAGE_CAP } from './collect';

describe('capDiagnosticMessages (Bug 2: 导出诊断包冻死)', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}` }));

  it('keeps only the last N messages when over the cap, reporting the total', () => {
    const r = capDiagnosticMessages(many, 200);
    expect(r.capped).toBe(true);
    expect(r.total).toBe(250);
    expect(r.messages).toHaveLength(200);
    expect(r.messages[0].id).toBe('m50');       // dropped the oldest 50
    expect(r.messages[199].id).toBe('m249');    // kept the most recent
  });

  it('returns everything untouched when under the cap', () => {
    const few = many.slice(0, 10);
    const r = capDiagnosticMessages(few, 200);
    expect(r.capped).toBe(false);
    expect(r.total).toBe(10);
    expect(r.messages).toBe(few);               // same reference — no copy
  });

  it("'all' disables the cap even for huge conversations", () => {
    const r = capDiagnosticMessages(many, 'all');
    expect(r.capped).toBe(false);
    expect(r.messages).toHaveLength(250);
  });

  it('has a sane default cap', () => {
    expect(DEFAULT_DIAGNOSTIC_MESSAGE_CAP).toBe(200);
  });
});
