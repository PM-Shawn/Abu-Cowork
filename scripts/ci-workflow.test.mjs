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

function jobBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:`);
  assert.ok(start > -1, `${name} job missing`);
  const next = source.slice(start + 1).search(/\n  [a-z][\w-]*:/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

// Steps that used to live in the monolithic `check` job now sit in one of the
// parallel jobs it was split into. They must still be blocking, and still be
// skipped when the install step failed.
function requiredCheckStep(name, jobName = 'test') {
  const job = jobBlock(ci, jobName);
  assert.doesNotMatch(job, /continue-on-error:\s*true/);
  const start = job.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `${name} must run in the ${jobName} job, not an advisory job`);
  const next = job.indexOf('\n      - name:', start + 1);
  const step = job.slice(start, next < 0 ? undefined : next);
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
  const step = requiredCheckStep('Verify Chrome extension bundle is in sync with source', 'build');
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

test('e2e-electron fans out across shards behind a facade job that fails loud', () => {
  const workflow = YAML.parse(e2e);
  const shard = workflow.jobs?.['e2e-electron-shard'];
  assert.ok(shard, 'e2e-electron-shard job missing');
  assert.deepEqual(shard.strategy?.matrix?.shard, [1, 2, 3]);
  // One red shard must not cancel its siblings: surface every failure in one round.
  assert.equal(shard.strategy?.['fail-fast'], false, 'shards must not cancel each other');
  assert.equal(shard['continue-on-error'], undefined, 'shards must remain blocking');
  const shardRun = JSON.stringify(shard.steps);
  assert.match(shardRun, /--shard=\$\{\{ matrix\.shard \}\}\/3/, 'shard job must pass --shard');
  const traces = shard.steps.find((step) => step.name === 'Upload Electron E2E traces');
  assert.equal(traces?.with?.name, 'electron-e2e-test-results-shard-${{ matrix.shard }}');

  const facade = workflow.jobs?.['e2e-electron'];
  assert.equal(facade.needs, 'e2e-electron-shard', 'facade must depend on the shards');
  // Without always(), a failing upstream can leave the required check skipped.
  assert.equal(facade.if, 'always()', 'facade must use `if: always()`');
  const facadeRun = JSON.stringify(facade.steps);
  assert.match(
    facadeRun,
    /needs\['e2e-electron-shard'\]\.result/,
    'facade must inspect the shard job result explicitly',
  );
  assert.match(facadeRun, /exit 1/, 'facade must fail when a shard did not succeed');
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
  const testJob = jobBlock(ci, 'test');
  const checkoutStart = testJob.indexOf('- uses: actions/checkout@v7');
  assert.ok(checkoutStart > -1, 'checkout step missing');
  const checkoutEnd = testJob.indexOf('\n      - name:', checkoutStart);
  const checkout = testJob.slice(checkoutStart, checkoutEnd);
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

test('only the test job gets pull-requests write; every other job is contents-read only', () => {
  assert.doesNotMatch(ci, /^permissions:/m, 'permissions must be job-scoped, not workflow-level');
  for (const job of ['test-windows', 'audit', 'leak-guard', 'lint', 'typecheck', 'build', 'check']) {
    const block = jobBlock(ci, job);
    assert.ok(!block.includes('pull-requests: write'), `${job} must not get pull-requests: write`);
    assert.ok(!block.includes('checks: write'), `${job} must not get checks: write`);
    assert.match(block, /permissions:\n\s+contents: read/);
  }
  // The coverage comment and the junit check run are the only token writes.
  assert.match(
    jobBlock(ci, 'test'),
    /permissions:\n\s+contents: read\n\s+pull-requests: write\n\s+checks: write/,
  );
});

test('the check facade fails loud when any parallel gate job did not succeed', () => {
  const workflow = YAML.parse(ci);
  const facade = workflow.jobs?.check;
  assert.ok(facade, 'check facade missing');
  assert.equal(facade.name ?? 'check', 'check', 'required check context must stay check');
  assert.equal(facade['continue-on-error'], undefined, 'check must remain blocking');
  assert.ok(Array.isArray(facade.needs), 'check must depend on the parallel jobs');
  assert.deepEqual(
    [...facade.needs].sort(),
    ['build', 'leak-guard', 'lint', 'test', 'typecheck'],
    'the check facade must depend on every parallel gate job',
  );
  // Without `if: always()` the facade is SKIPPED when an upstream job fails,
  // and a skipped required check can read as success — a silent bypass.
  assert.equal(facade.if, 'always()', 'check facade must use `if: always()`');
  const steps = JSON.stringify(facade.steps);
  for (const dep of ['leak-guard', 'lint', 'typecheck', 'test', 'build']) {
    assert.ok(steps.includes(`needs['${dep}'].result`), `facade must inspect ${dep}.result`);
  }
  assert.match(steps, /exit 1/, 'facade must fail when an upstream job did not succeed');
});

test('only the test job fetches full history, for changed-line coverage', () => {
  assert.match(
    jobBlock(ci, 'test'),
    /uses: actions\/checkout@v7\n\s+with:\n\s+fetch-depth: 0/,
    'the test job needs full history to diff against the pull request base',
  );
  const workflow = YAML.parse(ci);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'test') continue;
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with?.['fetch-depth'], undefined, `${name} must keep a shallow checkout`);
      }
    }
  }
});

test('parallel gates preserve their commands, full installs, and blocking outcomes', () => {
  const workflow = YAML.parse(ci);
  for (const name of ['leak-guard', 'lint', 'typecheck', 'test', 'build']) {
    const job = workflow.jobs[name];
    assert.ok(job, `${name} job missing`);
    assert.equal(job.needs, undefined, `${name} must run independently`);
    assert.equal(job['continue-on-error'], undefined, `${name} must remain blocking`);
    if (name === 'leak-guard') {
      assert.equal(job.steps.find((step) => step.name === 'Enterprise leak guard (open-core)')?.run,
        'bash scripts/enterprise-leak-guard.sh');
      continue;
    }
    assert.equal(job.steps.find((step) => step.id === 'install')?.run.trim(),
      'npm ci\n(cd abu-browser-bridge && npm ci)\n(cd abu-chrome-extension && npm ci)');
  }
  for (const [job, step, command] of [
    ['lint', 'Lint', 'npm run lint'],
    ['typecheck', 'Type check', 'npm run typecheck'],
    ['test', 'Test with coverage', 'npm run test:coverage'],
    ['test', 'Test-infra scripts (node:test)', 'npm run test:infra'],
    ['test', 'TESTING.md inventory is up to date', 'npm run test:inventory:check'],
    ['build', 'Build frontend', 'npm run build'],
  ]) {
    assert.ok(requiredCheckStep(step, job).includes(`run: ${command}\n`));
  }
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
    const block = requiredCheckStep(step, 'test');
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

test('the pull request Windows build skips renderer-only changes', () => {
  const workflow = YAML.parse(
    readFileSync(path.join(repoRoot, '.github/workflows/electron-build.yml'), 'utf8'),
  );
  const paths = workflow.on?.pull_request?.paths ?? [];
  assert.ok(paths.length > 0, 'the pull request trigger must keep a paths filter');
  // Renderer sources cannot break Windows packaging in a way `check`'s
  // `npm run build` and the macOS e2e-electron app launch do not already catch,
  // and release.yml re-runs the full Windows package + smoke via workflow_call.
  for (const dropped of ['src/**', 'public/**']) {
    assert.ok(!paths.includes(dropped), `${dropped} must not trigger the pull request Windows build`);
  }
  // Everything that CAN break packaging must still trigger it.
  for (const kept of [
    'electron/**',
    'scripts/**',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'vite.config.ts',
  ]) {
    assert.ok(paths.includes(kept), `${kept} must still trigger the pull request Windows build`);
  }
  // The trigger itself must not move: 6 steps use `github.event_name !=
  // 'pull_request'` to mean "official release build", and a reusable workflow
  // reports the CALLER's event, so a dev push and a release tag are
  // indistinguishable by event_name.
  assert.ok(workflow.on?.pull_request, 'the Windows build must stay on pull_request');
  assert.equal(workflow.on?.push, undefined, 'the Windows build must not gain a push trigger');
});

test('CI and Electron Build cancel superseded pull request runs without serialising branch pushes', () => {
  const electronBuild = readFileSync(
    path.join(repoRoot, '.github/workflows/electron-build.yml'),
    'utf8',
  );
  for (const [label, source] of [
    ['ci.yml', ci],
    ['electron-build.yml', electronBuild],
  ]) {
    const workflow = YAML.parse(source);
    assert.ok(workflow.concurrency, `${label} must declare a concurrency group`);
    // Keyed on github.sha for non-PR events: a shared key would make successive
    // dev pushes QUEUE behind each other (cancel-in-progress is false there),
    // which is slower than today, not faster.
    assert.match(
      String(workflow.concurrency.group),
      /github\.event_name == 'pull_request' && github\.ref \|\| github\.sha/,
      `${label} concurrency group must fall back to github.sha off pull requests`,
    );
    assert.match(
      String(workflow.concurrency['cancel-in-progress']),
      /github\.event_name == 'pull_request'/,
      `${label} must only cancel in-progress runs on pull requests`,
    );
  }
});
