/**
 * Resolve the "as-of" date used by the quarantine SLA meta-test.
 *
 * CI injects QUARANTINE_ASOF=YYYY-MM-DD (see .github/workflows/ci.yml) so the
 * SLA clock advances automatically on every run. Locally the env var is
 * usually absent and the committed fallback applies — that keeps the test
 * deterministic (no Date.now()) while still letting CI enforce the window.
 *
 * A malformed value throws rather than falling back: a typo in CI must not
 * silently freeze the clock again (that is exactly how the SLA stalled from
 * 2026-06-30 to 2026-09-02).
 */
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function resolveQuarantineAsOf(
  env: Record<string, string | undefined>,
  fallback: string,
): Date {
  const raw = env.QUARANTINE_ASOF;
  const source = raw && raw.length > 0 ? raw : fallback;
  const m = YMD.exec(source);
  if (!m) {
    throw new Error(`QUARANTINE_ASOF must be YYYY-MM-DD, got "${source}"`);
  }
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Reject impossible dates (e.g. 2026-13-40 rolls over silently in Date.UTC).
  if (date.toISOString().slice(0, 10) !== source) {
    throw new Error(`QUARANTINE_ASOF must be YYYY-MM-DD, got "${source}"`);
  }
  return date;
}
