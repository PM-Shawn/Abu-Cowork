import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GateInputError,
  calculateChangedLinesCoverage,
  extractExemptionReason,
  parseAddedLineRanges,
  parseLcov,
  parsePullRequestExemption,
  readRequiredLcov,
  renderCoverageSummary,
  runCoverageGate,
} from './changed-lines-coverage.mjs';

const repoRoot = '/repo';

function lcovFixture(records) {
  return records
    .map(({ file, lines }) => [
      'TN:',
      `SF:${file}`,
      ...lines.map(([line, count]) => `DA:${line},${count}`),
      'end_of_record',
    ].join('\n'))
    .join('\n');
}

function changedFixture(entries) {
  return new Map(entries.map(([file, lines]) => [file, new Set(lines)]));
}

test('parseLcov normalizes relative and absolute paths and merges duplicate DA records', () => {
  const coverage = parseLcov(lcovFixture([
    { file: './src/a.ts', lines: [[2, 0], [3, 1]] },
    { file: '/repo/src/a.ts', lines: [[2, 4], [4, 0]] },
    { file: 'src/b.tsx', lines: [[8, 2]] },
  ]), { repoRoot });

  assert.deepEqual([...coverage.keys()], ['src/a.ts', 'src/b.tsx']);
  assert.deepEqual([...coverage.get('src/a.ts')], [[2, 4], [3, 1], [4, 0]]);
  assert.deepEqual([...coverage.get('src/b.tsx')], [[8, 2]]);
});

test('parseLcov fails loudly on empty, malformed, or out-of-repository input', () => {
  for (const input of [
    '',
    'DA:1,1\n',
    'SF:src/a.ts\nDA:not-a-line,1\nend_of_record\n',
    'SF:src/a.ts\nend_of_record\n',
    'SF:../outside.ts\nDA:1,1\nend_of_record\n',
  ]) {
    assert.throws(
      () => parseLcov(input, { repoRoot }),
      (error) => error instanceof GateInputError && error.exitCode === 2,
    );
  }
});

test('parseAddedLineRanges expands zero-context hunks and deduplicates overlapping lines', () => {
  const lines = parseAddedLineRanges([
    'diff --git a/src/a.ts b/src/a.ts',
    '@@ -4 +4 @@',
    '-old',
    '+new',
    '@@ -9,0 +10,3 @@',
    '+a',
    '+b',
    '+c',
    '@@ -12,0 +12,2 @@',
    '+c',
    '+d',
    '@@ -20,2 +22,0 @@',
    '-gone',
  ].join('\n'));

  assert.deepEqual([...lines].sort((a, b) => a - b), [4, 10, 11, 12, 13]);
  assert.throws(
    () => parseAddedLineRanges('@@ malformed @@'),
    (error) => error instanceof GateInputError && error.exitCode === 2,
  );
});

test('calculateChangedLinesCoverage passes fully covered added lines', () => {
  const coverage = parseLcov(lcovFixture([
    { file: 'src/a.ts', lines: [[4, 1], [5, 3]] },
  ]), { repoRoot });
  const result = calculateChangedLinesCoverage(
    changedFixture([['src/a.ts', [4, 5]]]),
    coverage,
  );

  assert.equal(result.testable, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.percentage, 100);
  assert.equal(result.passed, true);
  assert.deepEqual(result.files[0].uncoveredLines, []);
});

test('calculateChangedLinesCoverage aggregates partial coverage across files', () => {
  const coverage = parseLcov(lcovFixture([
    { file: 'src/a.ts', lines: [[2, 1], [3, 0], [9, 0]] },
    { file: 'src/b.tsx', lines: [[8, 2], [9, 0]] },
  ]), { repoRoot });
  const result = calculateChangedLinesCoverage(changedFixture([
    ['src/b.tsx', [8, 9, 10]],
    ['src/a.ts', [2, 3, 4]],
    ['src/not-in-lcov.ts', [1, 2]],
  ]), coverage);

  assert.equal(result.testable, 4);
  assert.equal(result.covered, 2);
  assert.equal(result.percentage, 50);
  assert.equal(result.passed, false);
  assert.deepEqual(result.files.map((file) => [file.file, file.testable, file.uncoveredLines]), [
    ['src/a.ts', 2, [3]],
    ['src/b.tsx', 2, [9]],
    ['src/not-in-lcov.ts', 0, []],
  ]);
});

test('calculateChangedLinesCoverage uses an exact 80 percent aggregate threshold', () => {
  const coverage = parseLcov(lcovFixture([
    { file: 'src/a.ts', lines: [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0], [6, 0]] },
  ]), { repoRoot });

  assert.equal(calculateChangedLinesCoverage(
    changedFixture([['src/a.ts', [1, 2, 3, 4, 5]]]),
    coverage,
  ).passed, true);
  assert.equal(calculateChangedLinesCoverage(
    changedFixture([['src/a.ts', [1, 2, 3, 4, 5, 6]]]),
    coverage,
  ).passed, false);
});

test('calculateChangedLinesCoverage passes when no added line has an LCOV DA record', () => {
  const coverage = parseLcov(lcovFixture([
    { file: 'src/a.ts', lines: [[20, 1]] },
  ]), { repoRoot });
  const result = calculateChangedLinesCoverage(changedFixture([
    ['src/a.ts', [1, 2]],
    ['src/components/view.tsx', [4, 5]],
  ]), coverage);

  assert.equal(result.testable, 0);
  assert.equal(result.percentage, null);
  assert.equal(result.passed, true);
  assert.match(renderCoverageSummary(result), /no testable added lines/i);
});

test('readRequiredLcov and the CLI gate return exit 2 when lcov.info is missing', () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const failRead = () => { throw missing; };
  assert.throws(
    () => readRequiredLcov('/repo/coverage/lcov.info', failRead),
    (error) => error instanceof GateInputError && error.exitCode === 2,
  );

  const errors = [];
  const exitCode = runCoverageGate({
    argv: [],
    env: {},
    repoRoot,
    readFile: failRead,
    stderr: (message) => errors.push(message),
  });
  assert.equal(exitCode, 2);
  assert.match(errors.join('\n'), /Required LCOV file is unavailable/);
});

test('the CLI gate returns 1 below threshold and 0 for a reasoned exemption using only fixtures', () => {
  const lcov = lcovFixture([
    { file: 'src/a[fixture].ts', lines: [[1, 1], [2, 0]] },
  ]);
  const event = JSON.stringify({
    pull_request: {
      labels: [{ name: 'gate:changed-lines-exempt' }],
      body: '## 门禁\n- 豁免理由：Mechanical generated change.\n',
    },
  });
  const makeFixtureSpawn = (calls) => {
    const outputs = [
      `${'a'.repeat(40)}\n`,
      'src/a[fixture].ts\0',
      '@@ -0,0 +1,2 @@\n+covered\n+uncovered\n',
    ];
    return (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: outputs.shift(), stderr: '' };
    };
  };
  const readFile = (file) => file === '/event' ? event : lcov;

  const failedOutput = [];
  const failedCalls = [];
  assert.equal(runCoverageGate({
    argv: ['--base', 'fixture-base'],
    env: {},
    repoRoot,
    readFile,
    spawn: makeFixtureSpawn(failedCalls),
    stdout: (message) => failedOutput.push(message),
  }), 1);
  assert.match(failedOutput.join('\n'), /fail — 50\.00%/);
  assert.ok(failedOutput.join('\n').includes('| src/a\\[fixture\\].ts | 2 | 1 | 2 |'));
  assert.deepEqual(failedCalls[0].args, [
    'rev-parse', '--verify', '--end-of-options', 'fixture-base^{commit}',
  ]);
  assert.ok(failedCalls.every((call) => call.command === 'git' && call.options.shell === false));
  assert.ok(failedCalls[2].args.includes('--inter-hunk-context=0'));
  assert.equal(failedCalls[2].args.at(-1), ':(literal)src/a[fixture].ts');

  const exemptOutput = [];
  assert.equal(runCoverageGate({
    argv: ['--base=fixture-base'],
    env: { GITHUB_EVENT_PATH: '/event' },
    repoRoot,
    readFile,
    spawn: makeFixtureSpawn([]),
    stdout: (message) => exemptOutput.push(message),
  }), 0);
  assert.ok(exemptOutput[0].startsWith('> [!WARNING]\n'));
  assert.match(exemptOutput[0], /Mechanical generated change/);
});

test('the exemption requires both the exact label and a reason inside the Gate section', () => {
  const payload = (labels, body) => JSON.stringify({
    pull_request: {
      labels: labels.map((name) => ({ name })),
      body,
    },
  });
  const validBody = [
    '## 改了什么 · 为什么',
    'Mechanical rewrite.',
    '## 门禁',
    '- [x] verify passed',
    '- 豁免理由：Generated bindings changed in bulk.',
    '## 真机验收',
    'N/A',
  ].join('\n');

  assert.equal(
    parsePullRequestExemption(payload(['gate:changed-lines-exempt'], validBody)),
    'Generated bindings changed in bulk.',
  );
  assert.equal(parsePullRequestExemption(payload([], validBody)), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '## 门禁\n- 豁免理由：<!-- required when exempt -->\n',
  )), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '## 其他\n- 豁免理由：Outside the required section.\n',
  )), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '<!--\n## 门禁\n- 豁免理由：Invisible template text.\n-->\n',
  )), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '## 门禁\n# Next H1\n- 豁免理由：Outside the gate section.\n',
  )), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '## 门禁\n## Next H2\n- 豁免理由：Outside the gate section.\n',
  )), null);
  assert.equal(parsePullRequestExemption(payload(
    ['gate:changed-lines-exempt'],
    '## 门禁\n<!-- unclosed\n- 豁免理由：Hidden to EOF.\n',
  )), null);
  assert.equal(extractExemptionReason(null), null);
});

test('invalid GitHub payload shapes fail closed with exit 2 errors', () => {
  for (const payload of [
    'not-json',
    '[]',
    '{"pull_request":{"labels":"not-an-array","body":null}}',
    '{"pull_request":{"labels":[{"name":7}],"body":null}}',
    '{"pull_request":{"labels":[{"name":"gate:changed-lines-exempt"}],"body":7}}',
  ]) {
    assert.throws(
      () => parsePullRequestExemption(payload),
      (error) => error instanceof GateInputError && error.exitCode === 2,
    );
  }
});

test('summary escapes untrusted PR reasons and filenames before rendering Markdown', () => {
  const report = {
    files: [{
      file: 'src/a|b\n## forged.ts',
      testable: 1,
      covered: 0,
      uncoveredLines: [7],
    }],
    testable: 1,
    covered: 0,
    percentage: 0,
    threshold: 80,
    passed: false,
  };
  const summary = renderCoverageSummary(
    report,
    'needed <script>alert(1)</script> @maintainers | **forged**',
  );

  assert.ok(summary.startsWith('> [!WARNING]\n'));
  assert.doesNotMatch(summary, /<script>|@maintainers|\n## forged/);
  assert.match(summary, /&lt;script&gt;/);
  assert.match(summary, /&#64;maintainers/);
  assert.match(summary, /a\\\|b ## forged\.ts/);
  assert.match(summary, /Result: pass — 0\.00%/);
});
