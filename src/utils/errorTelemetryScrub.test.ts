import { describe, it, expect } from 'vitest';
import { normalizeErrorMessage, errorFingerprint } from './errorTelemetryScrub';

describe('normalizeErrorMessage', () => {
  // The audit's RB-05 repro: this exact string used to leave the machine
  // intact, alongside a stable device id.
  it('strips the user path out of the reported crash message', () => {
    const raw = "Failed reading /Users/alice/SecretClient/acquisition-plan.txt: board-memo";
    const out = normalizeErrorMessage(raw)!;

    expect(out).not.toContain('alice');
    expect(out).not.toContain('SecretClient');
    expect(out).not.toContain('acquisition-plan');
    // The diagnostic skeleton survives — this is still recognisably a read
    // failure, which is the whole point of normalising instead of dropping.
    expect(out).toContain('Failed reading');
  });

  it.each([
    ['posix path', "ENOENT: no such file or directory, open '/Users/bob/客户/plan.docx'", ['bob', '客户', 'plan.docx']],
    ['windows path', 'EPERM: operation not permitted, C:\\Users\\bob\\Desktop\\payroll.xlsx', ['bob', 'payroll']],
    ['unc path', 'Cannot reach \\\\fileserver\\finance\\q4', ['fileserver', 'finance']],
    ['url', 'Request failed: https://internal.acme.com/api/customers?name=bob', ['acme', 'customers', 'bob']],
    ['email', 'Sync rejected for alice@acmecorp.com', ['alice', 'acmecorp']],
    ['cjk business text', 'Conversation 客户方案讨论 not found', ['客户方案讨论']],
    ['quoted value', 'Unknown provider "Acme Internal Gateway"', ['Acme', 'Gateway']],
  ])('removes %s', (_label, raw, forbidden) => {
    const out = normalizeErrorMessage(raw)!;
    for (const secret of forbidden) {
      expect(out, secret).not.toContain(secret);
    }
  });

  it('keeps redacting the credential shapes the previous scrub caught', () => {
    const out = normalizeErrorMessage('auth failed sk-abcdefghijklmnop and Bearer abcdefghij')!;
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).not.toContain('abcdefghij');
    expect(out).toContain('[REDACTED]');
  });

  // Pins what the rule ORDER actually produces, since the quote rule runs
  // last and swallows the placeholder the path rule just wrote. Documented
  // in the module; asserted here so the two cannot drift apart again.
  it('redacts a quoted path to <str> and a bare path to <path>', () => {
    expect(normalizeErrorMessage("ENOENT: open '/Users/a/b.txt'")).toBe('ENOENT: open <str>');
    expect(normalizeErrorMessage('ENOENT: open /Users/a/b.txt')).toBe('ENOENT: open <path>');
  });

  it('leaves a message that carries no user content readable', () => {
    expect(normalizeErrorMessage('Maximum call stack size exceeded'))
      .toBe('Maximum call stack size exceeded');
  });

  // The documented limit of shape-based normalisation, pinned so nobody
  // reads the guarantee as wider than it is: a bare unquoted token is
  // indistinguishable from ordinary error prose ("board-memo" has the same
  // shape as "connection refused"), so it survives. Everything that CARRIES
  // a recognisable shape — path, url, email, CJK, quoted span, credential —
  // does not. Closing this last gap means dropping the message entirely and
  // reporting `errorType` + `errorCode` + `fingerprint` only; the fingerprint
  // is already computed from the normalised text, so that switch costs one
  // line and loses no grouping.
  it('does NOT remove an unquoted bare token — shape-based scrubbing cannot', () => {
    expect(normalizeErrorMessage('Unknown provider board-memo'))
      .toContain('board-memo');
  });

  it('caps length and returns null for nothing to report', () => {
    expect(normalizeErrorMessage('x'.repeat(900))).toHaveLength(500);
    expect(normalizeErrorMessage(undefined)).toBeNull();
    expect(normalizeErrorMessage('')).toBeNull();
  });

  it('strips control characters', () => {
    expect(normalizeErrorMessage('a\u0007b\u0000c')).toBe('abc');
  });
});

describe('errorFingerprint', () => {
  it('groups the same failure across machines whose private spans differ', () => {
    const a = normalizeErrorMessage("ENOENT: open '/Users/alice/a.txt'");
    const b = normalizeErrorMessage("ENOENT: open '/Users/bob/b.txt'");

    expect(a).toEqual(b);
    expect(errorFingerprint(a)).toEqual(errorFingerprint(b));
  });

  it('separates genuinely different failures', () => {
    expect(errorFingerprint(normalizeErrorMessage('ENOENT: open <str>')))
      .not.toEqual(errorFingerprint(normalizeErrorMessage('EPERM: open <str>')));
  });

  it('is stable — a fingerprint is a wire value, not a per-run token', () => {
    expect(errorFingerprint('Maximum call stack size exceeded'))
      .toBe(errorFingerprint('Maximum call stack size exceeded'));
    expect(errorFingerprint(null)).toBeNull();
  });
});
