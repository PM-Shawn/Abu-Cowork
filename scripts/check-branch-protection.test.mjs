import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareBranchProtection,
  parseExpectedBranchProtection,
  requiredStatusChecksApiArgs,
  shouldCheckBranchProtection,
} from './check-branch-protection.mjs';

const expectedFixture = JSON.stringify({
  dev: ['check', 'e2e-electron'],
  main: ['check', 'promotion-ready'],
});

test('parses and sorts the committed branch-to-context fixture shape', () => {
  assert.deepEqual(parseExpectedBranchProtection(expectedFixture), {
    dev: ['check', 'e2e-electron'],
    main: ['check', 'promotion-ready'],
  });
});

test('compares contexts without depending on GitHub response order', () => {
  const expected = parseExpectedBranchProtection(expectedFixture);
  assert.deepEqual(
    compareBranchProtection(expected, {
      dev: { strict: true, contexts: ['e2e-electron', 'check'] },
      main: { strict: true, contexts: ['promotion-ready', 'check'] },
    }),
    [],
  );
});

test('reports weakened strict mode and missing or extra contexts', () => {
  const expected = parseExpectedBranchProtection(expectedFixture);
  const errors = compareBranchProtection(expected, {
    dev: { strict: false, contexts: ['check'] },
    main: { strict: true, contexts: ['check', 'promotion-ready', 'unexpected'] },
  });

  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /dev: strict must be true/);
  assert.match(errors.join('\n'), /dev: required contexts/);
  assert.match(errors.join('\n'), /main: required contexts/);
});

test('builds an explicit read-only gh api request', () => {
  assert.deepEqual(requiredStatusChecksApiArgs('PM-Shawn/Abu-Cowork', 'release/v1'), [
    'api',
    '--method',
    'GET',
    'repos/PM-Shawn/Abu-Cowork/branches/release%2Fv1/protection/required_status_checks',
  ]);
});

test('allows only GitHub Actions to skip the local branch-protection read', () => {
  assert.equal(
    shouldCheckBranchProtection({ skipRequested: false, githubActions: undefined }),
    true,
  );
  assert.equal(
    shouldCheckBranchProtection({ skipRequested: true, githubActions: 'true' }),
    false,
  );
  assert.throws(
    () => shouldCheckBranchProtection({ skipRequested: true, githubActions: undefined }),
    /only allowed inside GitHub Actions/,
  );
});
