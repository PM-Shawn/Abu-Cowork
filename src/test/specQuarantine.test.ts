import { describe, expect, it } from 'vitest';
import { inspectSpecQuarantines } from './specQuarantine';

const AS_OF = new Date('2026-09-08T00:00:00.000Z');

describe('inspectSpecQuarantines', () => {
  it('accepts a test.fixme quarantine inside the four-week SLA', () => {
    const quarantines = inspectSpecQuarantines(
      'e2e/chat.spec.ts',
      "test.fixme(true, 'QUARANTINED: https://github.com/acme/app/issues/7 (2026-08-12)')",
      AS_OF,
    );

    expect(quarantines).toEqual([
      { issueUrl: 'https://github.com/acme/app/issues/7', date: '2026-08-12' },
    ]);
  });

  it('rejects an expired spec quarantine', () => {
    expect(() =>
      inspectSpecQuarantines(
        'tests/e2e/smoke.spec.ts',
        "test.fixme(true, 'QUARANTINED: https://github.com/acme/app/issues/7 (2026-08-10)')",
        AS_OF,
      ),
    ).toThrow(/exceeds the 28-day SLA/);
  });

  it('rejects a marker that is not a reasoned test.fixme', () => {
    expect(() =>
      inspectSpecQuarantines(
        'e2e/chat.spec.ts',
        "test.skip(true, 'QUARANTINED: https://github.com/acme/app/issues/7 (2026-09-08)')",
        AS_OF,
      ),
    ).toThrow(/every QUARANTINED marker must use test\.fixme/);
  });
});
