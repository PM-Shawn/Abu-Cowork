/**
 * Stable release tags may only point at a commit that is already on the
 * release branch. `main` receives the exact `dev` SHA by fast-forward, so a
 * stable tag on any other commit would publish code that never went through
 * promotion. release-preflight.mjs runs this for both `npm run release:check
 * -- --tag vX.Y.Z` and the release workflow.
 */
import { spawnSync } from 'node:child_process';

export const RELEASE_BRANCH = 'main';
export const RELEASE_BRANCH_REF = `refs/remotes/origin/${RELEASE_BRANCH}`;

export function shouldCheckTagCommit({ tag, skipRequested, githubEventName }) {
  // A manual dispatch builds a private candidate from a branch and never
  // publishes, so it is the only run allowed to opt out.
  if (skipRequested && githubEventName !== 'workflow_dispatch') {
    throw new Error('--skip-tag-commit-check is only allowed in a manually dispatched release workflow run');
  }
  if (skipRequested || !tag) return false;
  // RC tags are cut on dev before promotion and never publish.
  return !tag.includes('-');
}

export function spawnGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitFailure(result) {
  return `exit ${result.status ?? 'unknown'}: ${String(result.stderr || result.stdout || '').trim()}`;
}

export function verifyTagCommitOnReleaseBranch({ tag, git }) {
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0) {
    return [`could not inspect the git checkout (${gitFailure(shallow)})`];
  }
  if (shallow.stdout.trim() === 'true') {
    return [
      `cannot verify that tag ${tag} is on ${RELEASE_BRANCH}: the checkout is shallow, so ancestry is unknown. ` +
        'Check out with full history (actions/checkout `fetch-depth: 0`, or `git fetch --unshallow origin` locally).',
    ];
  }

  const tagCommit = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (tagCommit.status !== 0) {
    return [
      `tag ${tag} does not exist in this checkout, so the commit it points to cannot be checked. ` +
        'Fetch tags (`git fetch origin --tags`) or create the tag before passing --tag.',
    ];
  }
  const tagSha = tagCommit.stdout.trim();

  const branchCommit = git(['rev-parse', '--verify', '--quiet', `${RELEASE_BRANCH_REF}^{commit}`]);
  if (branchCommit.status !== 0) {
    return [
      `cannot resolve origin/${RELEASE_BRANCH}, so tag ${tag} (commit ${tagSha}) cannot be checked against the release branch. ` +
        `Run \`git fetch origin ${RELEASE_BRANCH}\`; in CI, check out with \`fetch-depth: 0\`.`,
    ];
  }
  const branchSha = branchCommit.stdout.trim();

  const ancestry = git(['merge-base', '--is-ancestor', tagSha, branchSha]);
  if (ancestry.status === 0) return [];
  if (ancestry.status === 1) {
    return [
      `tag ${tag} points to commit ${tagSha}, which is not on origin/${RELEASE_BRANCH} (${branchSha}). ` +
        `A stable release must be the exact commit that was fast-forwarded from dev onto ${RELEASE_BRANCH}, ` +
        'otherwise code that never passed promotion would reach the update feeds. ' +
        `Delete the tag (\`git push origin :refs/tags/${tag}\` and \`git tag -d ${tag}\`), ` +
        `promote with \`git merge --ff-only dev\` and push ${RELEASE_BRANCH}, then tag the ${RELEASE_BRANCH} commit that matches the final RC.`,
    ];
  }
  return [`could not compare tag ${tag} (commit ${tagSha}) with origin/${RELEASE_BRANCH} (${gitFailure(ancestry)})`];
}
