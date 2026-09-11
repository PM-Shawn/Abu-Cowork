import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const e2e = readFileSync(path.join(repoRoot, '.github/workflows/e2e.yml'), 'utf8');
const release = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
const vitestConfig = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
const packageScripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;

function requiredCheckStep(name) {
  const check = ci.split('\n  check:')[1]?.split(/\n  [a-z][\w-]*:/)[0];
  assert.ok(check, 'required check job must exist');
  assert.doesNotMatch(check, /continue-on-error:\s*true/);
  const start = check.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `${name} must run in check, not an advisory job`);
  const next = check.indexOf('\n      - name:', start + 1);
  const step = check.slice(start, next < 0 ? undefined : next);
  assert.ok(step.includes("!cancelled() && steps.install.outcome == 'success'"));
  assert.doesNotMatch(step, /^\s*continue-on-error:|\|\|\s*true/m);
  return step;
}

test('browser host UI tests block check and local verify, including popup regressions', () => {
  assert.match(requiredCheckStep('Electron host UI tests'), /run: npm run electron:host-ui-test\s*$/);
  const stages = packageScripts['verify:full'].split(' && ');
  assert.ok(stages.indexOf('npm run electron:host-ui-test') > stages.indexOf('npm run check:browser-artifacts'));
  assert.ok(stages.indexOf('npm run electron:host-ui-test') < stages.indexOf('npm run test:coverage'));
  assert.ok(packageScripts['electron:host-ui-test'].split(' ').includes('electron/browserHost.popups.test.cjs'));
});

test('browser artifact gate builds runtimes and verifies the tracked copy before stamping it', () => {
  const step = requiredCheckStep('Verify Chrome extension bundle is in sync with source');
  const build = step.indexOf('npm run build:electron-browser-runtime');
  const compare = step.indexOf('if ! diff -r');
  const stamp = step.indexOf("recordSourceDigest('src-tauri/browser-extension/content.js')");
  const verify = step.indexOf('npm run check:browser-artifacts');
  assert.ok(build >= 0 && compare > build && stamp > compare && verify > stamp);
  assert.match(step.slice(compare, stamp), /exit 1\s*\n\s*fi/);
  // The instructions printed on drift may mention copy-resources; no command
  // may actually overwrite the tracked copy before the comparison.
  assert.doesNotMatch(step, /^\s*npm run copy-resources/m);
});
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('E2E required-check job names are stable, blocking, and run on PRs to dev', () => {
  const workflow = YAML.parse(e2e);
  assert.ok(workflow.jobs?.e2e, 'e2e job missing');
  assert.ok(workflow.jobs?.['e2e-electron'], 'e2e-electron job missing');
  for (const jobName of ['e2e', 'e2e-electron']) {
    assert.equal(
      workflow.jobs[jobName].name ?? jobName,
      jobName,
      `${jobName} display name must match the required check context`,
    );
    assert.equal(
      workflow.jobs[jobName]['continue-on-error'],
      undefined,
      `${jobName} must remain blocking`,
    );
  }
  assert.ok(
    workflow.on?.pull_request?.branches?.includes('dev'),
    'E2E workflow must run for pull requests to dev',
  );
});

test('release CI explicitly skips the local-only branch-protection read', () => {
  assert.match(
    packageJson.scripts['release:check'],
    /^node scripts\/release-preflight\.mjs$/,
    'the local release command must keep the branch-protection check enabled',
  );
  assert.match(
    release,
    /node scripts\/release-preflight\.mjs --tag "\$CANDIDATE_VERSION" --skip-branch-protection/,
  );
  assert.doesNotMatch(e2e, /check-branch-protection|skip-branch-protection/);
});

test('CI injects QUARANTINE_ASOF so the quarantine SLA clock advances', () => {
  assert.match(ci, /QUARANTINE_ASOF=\$\(date -u \+%F\)/);
});

test('vitest emits junit + machine-readable coverage for CI reports', () => {
  assert.match(vitestConfig, /\['junit', \{ outputFile: 'test-results\/junit\.xml' \}\]/);
  for (const r of ["'text'", "'html'", "'lcov'", "'json-summary'", "'json'"]) {
    assert.ok(vitestConfig.includes(r), `coverage.reporter missing ${r}`);
  }
});

test('CI checks changed-line coverage against the pull request base with full history', () => {
  assert.match(
    ci,
    /pull_request:\n\s+branches: \[main, dev\]\n(?:\s+#[^\n]*\n)*\s+types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]/,
    'body and label edits must re-evaluate gate exemptions',
  );
  const checkoutStart = ci.indexOf('- uses: actions/checkout@v7');
  assert.ok(checkoutStart > -1, 'checkout step missing');
  const checkoutEnd = ci.indexOf('\n      - name:', checkoutStart);
  const checkout = ci.slice(checkoutStart, checkoutEnd);
  assert.match(checkout, /with:\n\s+fetch-depth: 0/);

  const coverageStart = ci.indexOf('- name: Test with coverage');
  const changedStart = ci.indexOf('- name: Changed-lines coverage (80%)');
  const infraStart = ci.indexOf('- name: Test-infra scripts (node:test)');
  assert.ok(coverageStart > -1 && changedStart > coverageStart, 'changed-lines gate must follow coverage');
  assert.ok(infraStart > changedStart, 'changed-lines gate must precede test-infra scripts');

  const changed = ci.slice(changedStart, infraStart);
  assert.ok(
    changed.includes("if: ${{ github.event_name == 'pull_request' && !cancelled() && steps.install.outcome == 'success' }}"),
    'changed-lines gate must run on pull requests after a successful install',
  );
  assert.match(changed, /DIFF_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(changed, /npm run coverage:changed -- --base "\$DIFF_BASE"/);
  assert.doesNotMatch(changed, /dependabot/i, 'Dependabot must use the same changed-lines rule');
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

test('Windows unit-test job exists and is advisory for now', () => {
  assert.match(ci, /test-windows:[\s\S]*?runs-on: windows-latest[\s\S]*?continue-on-error: true/);
});

test('npm audit job is allowlist-aware and fails for real (no continue-on-error)', () => {
  const auditStart = ci.indexOf('\n  audit:');
  assert.ok(auditStart > -1, 'audit job missing');
  const audit = ci.slice(auditStart);
  assert.ok(!audit.includes('continue-on-error'), 'audit must not be advisory: the allowlist is the escape hatch');
  // Production deps only, machine-readable, and `|| true` because npm audit exits
  // non-zero on any finding — the checker script is what decides pass/fail.
  assert.match(audit, /npm audit --omit=dev --json > audit\.json \|\| true/);
  assert.match(audit, /node scripts\/npm-audit-check\.mjs audit\.json \| tee -a "\$GITHUB_STEP_SUMMARY"/);
  // Without an explicit shell: GitHub runs bash without pipefail, so tee would
  // swallow the checker's exit status.
  assert.ok(audit.includes('PIPESTATUS[0]'), 'audit step must capture the checker exit status through tee');
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

test('junit report creates a real check run instead of only a job summary', () => {
  // dorny/test-reporter@v2 defaults to use-actions-summary: true, which writes the report
  // to the run summary and creates NO check run — it never reaches the PR's checks list.
  const start = ci.indexOf('- name: Test report (junit \u2192 check)');
  assert.ok(start > -1, 'Test report step missing');
  const next = ci.indexOf('\n      - name:', start + 1);
  const block = ci.slice(start, next === -1 ? undefined : next);
  assert.ok(
    block.includes('use-actions-summary: false'),
    'test-reporter must set use-actions-summary: false so it creates a check run',
  );
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
