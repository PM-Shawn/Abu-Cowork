import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELEASE_BRANCH_REF,
  shouldCheckTagCommit,
  verifyTagCommitOnReleaseBranch,
} from './release-tag-commit.mjs';

const TAG = 'v1.2.3';
const TAG_SHA = 'a'.repeat(40);
const MAIN_SHA = 'b'.repeat(40);

function fakeGit({ shallow = 'false', tagSha = TAG_SHA, mainSha = MAIN_SHA, ancestorStatus = 0 } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key === 'rev-parse --is-shallow-repository') return { status: 0, stdout: `${shallow}\n`, stderr: '' };
    if (key === `rev-parse --verify --quiet refs/tags/${TAG}^{commit}`) {
      return tagSha ? { status: 0, stdout: `${tagSha}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (key === `rev-parse --verify --quiet ${RELEASE_BRANCH_REF}^{commit}`) {
      return mainSha ? { status: 0, stdout: `${mainSha}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (key === `merge-base --is-ancestor ${TAG_SHA} ${MAIN_SHA}`) {
      return { status: ancestorStatus, stdout: '', stderr: ancestorStatus > 1 ? 'fatal: bad object' : '' };
    }
    throw new Error(`unexpected git call: ${key}`);
  };
  return { git, calls };
}

test('passes when the tag commit is on origin/main', () => {
  const { git, calls } = fakeGit();
  assert.deepEqual(verifyTagCommitOnReleaseBranch({ tag: TAG, git }), []);
  assert.deepEqual(calls.at(-1), ['merge-base', '--is-ancestor', TAG_SHA, MAIN_SHA]);
});

test('fails with the tag, both commits, the reason, and the fix when the tag commit is not on origin/main', () => {
  const { git } = fakeGit({ ancestorStatus: 1 });
  const errors = verifyTagCommitOnReleaseBranch({ tag: TAG, git });
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`tag ${TAG} points to commit ${TAG_SHA}`));
  assert.match(errors[0], new RegExp(`not on origin/main \\(${MAIN_SHA}\\)`));
  assert.match(errors[0], /fast-forwarded from dev onto main/);
  assert.match(errors[0], /git merge --ff-only dev/);
});

test('fails when origin/main cannot be resolved', () => {
  const { git, calls } = fakeGit({ mainSha: null });
  const errors = verifyTagCommitOnReleaseBranch({ tag: TAG, git });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cannot resolve origin\/main/);
  assert.match(errors[0], /git fetch origin main/);
  assert.ok(!calls.some((args) => args[0] === 'merge-base'), 'must not compare without a main ref');
});

test('fails instead of guessing when the checkout is shallow', () => {
  const { git, calls } = fakeGit({ shallow: 'true' });
  const errors = verifyTagCommitOnReleaseBranch({ tag: TAG, git });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /checkout is shallow/);
  assert.match(errors[0], /fetch-depth: 0/);
  assert.equal(calls.length, 1);
});

test('fails when the tag does not exist in the checkout', () => {
  const { git } = fakeGit({ tagSha: null });
  const errors = verifyTagCommitOnReleaseBranch({ tag: TAG, git });
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`tag ${TAG} does not exist`));
});

test('reports a git error from the ancestry comparison', () => {
  const { git } = fakeGit({ ancestorStatus: 128 });
  const errors = verifyTagCommitOnReleaseBranch({ tag: TAG, git });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not compare tag v1\.2\.3/);
  assert.match(errors[0], /exit 128: fatal: bad object/);
});

test('checks stable tags only, and allows only a manual dispatch to skip', () => {
  assert.equal(shouldCheckTagCommit({ tag: 'v1.2.3', skipRequested: false, githubEventName: 'push' }), true);
  assert.equal(shouldCheckTagCommit({ tag: 'v1.2.3', skipRequested: false, githubEventName: undefined }), true);
  assert.equal(shouldCheckTagCommit({ tag: 'v1.2.3-rc1', skipRequested: false, githubEventName: 'push' }), false);
  assert.equal(shouldCheckTagCommit({ tag: null, skipRequested: false, githubEventName: undefined }), false);
  assert.equal(
    shouldCheckTagCommit({ tag: '0.34.0', skipRequested: true, githubEventName: 'workflow_dispatch' }),
    false,
  );
  for (const githubEventName of ['push', undefined]) {
    assert.throws(
      () => shouldCheckTagCommit({ tag: 'v1.2.3', skipRequested: true, githubEventName }),
      /only allowed in a manually dispatched release workflow run/,
    );
  }
});
