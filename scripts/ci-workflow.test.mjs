import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const vitestConfig = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');

test('CI injects QUARANTINE_ASOF so the quarantine SLA clock advances', () => {
  assert.match(ci, /QUARANTINE_ASOF=\$\(date -u \+%F\)/);
});

test('vitest emits junit + machine-readable coverage for CI reports', () => {
  assert.match(vitestConfig, /\['junit', \{ outputFile: 'test-results\/junit\.xml' \}\]/);
  for (const r of ["'text'", "'html'", "'lcov'", "'json-summary'", "'json'"]) {
    assert.ok(vitestConfig.includes(r), `coverage.reporter missing ${r}`);
  }
});

test('CI uploads coverage and test-results artifacts even when tests fail', () => {
  assert.match(ci, /name: coverage-report[\s\S]*?path: coverage\//);
  assert.match(ci, /name: test-results[\s\S]*?path: test-results\//);
});

test('CI comments coverage on pull requests and renders the junit report', () => {
  assert.match(ci, /davelosert\/vitest-coverage-report-action@v2/);
  assert.match(ci, /dorny\/test-reporter@v2/);
  assert.match(ci, /pull-requests: write/);
  assert.match(ci, /checks: write/);
});

test('Windows unit-test job and npm audit job exist and are advisory for now', () => {
  assert.match(ci, /test-windows:[\s\S]*?runs-on: windows-latest[\s\S]*?continue-on-error: true/);
  const auditStart = ci.indexOf('\n  audit:');
  assert.ok(auditStart > -1, 'audit job missing');
  const audit = ci.slice(auditStart);
  assert.match(audit, /continue-on-error: true/);
  assert.match(audit, /npm audit --omit=dev --audit-level=high/);
  // Without an explicit shell: GitHub runs bash without pipefail, so tee would
  // swallow npm audit's exit status and continue-on-error would never engage.
  assert.ok(audit.includes('PIPESTATUS[0]'), 'audit step must capture npm audit exit status through tee');
  assert.ok(audit.includes('exit "$status"'), 'audit step must propagate the captured exit status');
});

test('CI checks that TESTING.md test inventory is up to date', () => {
  assert.match(ci, /npm run test:inventory:check/);
});
