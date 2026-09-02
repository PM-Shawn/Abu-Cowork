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
  for (const step of ['Upload coverage report', 'Upload test results (junit)']) {
    const start = ci.indexOf(`- name: ${step}`);
    assert.ok(start > -1, `${step} step missing`);
    const next = ci.indexOf('\n      - name:', start + 1);
    const block = ci.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes('!cancelled()'), `${step} must run on !cancelled(), not the default success()`);
  }
});

test('only the check job gets pull-requests write; advisory jobs are contents-read only', () => {
  assert.doesNotMatch(ci, /^permissions:/m, 'permissions must be job-scoped, not workflow-level');
  const jobBlock = (name) => {
    const start = ci.indexOf(`\n  ${name}:`);
    assert.ok(start > -1, `${name} job missing`);
    const next = ci.slice(start + 1).search(/\n  [a-z][\w-]*:/);
    return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };
  for (const job of ['test-windows', 'audit']) {
    const block = jobBlock(job);
    assert.ok(!block.includes('pull-requests: write'), `${job} must not get pull-requests: write`);
    assert.ok(!block.includes('checks: write'), `${job} must not get checks: write`);
    assert.match(block, /permissions:\n\s+contents: read/);
  }
  assert.match(jobBlock('check'), /permissions:\n\s+contents: read\n\s+pull-requests: write\n\s+checks: write/);
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

test('token-writing report steps are skipped when GITHUB_TOKEN is read-only (dependabot / fork PRs)', () => {
  const guard = "github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
  for (const step of ['Test report (junit → check)', 'Coverage comment on PR']) {
    const start = ci.indexOf(`- name: ${step}`);
    assert.ok(start > -1, `${step} step missing`);
    const next = ci.indexOf('\n      - name:', start + 1);
    const block = ci.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes(guard), `${step} must be guarded with: ${guard}`);
  }
});

test('Windows job relies on the config junit reporter (CLI --outputFile is inert in Vitest 4.1)', () => {
  const start = ci.indexOf('\n  test-windows:');
  assert.ok(start > -1, 'test-windows job missing');
  const windows = ci.slice(start, ci.indexOf('\n  audit:'));
  // Check the commands themselves, not the explanatory comment above them.
  const runLines = windows.split('\n').filter((l) => /^\s*run:/.test(l));
  assert.ok(runLines.every((l) => !l.includes('--outputFile')), 'Windows step must not pass --outputFile');
  assert.match(windows, /run: npx vitest run\n/);
});
