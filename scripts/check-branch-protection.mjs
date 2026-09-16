#!/usr/bin/env node
/**
 * Read-only branch-protection guard for the release operator's local machine.
 * GitHub Actions' token cannot read branch protection, so release.yml opts out
 * explicitly and the local `npm run release:check` command remains the source
 * of this verification.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY = 'PM-Shawn/Abu-Cowork';

export function shouldCheckBranchProtection({ skipRequested, githubActions }) {
  if (skipRequested && githubActions !== 'true') {
    throw new Error('--skip-branch-protection is only allowed inside GitHub Actions');
  }
  return !skipRequested;
}

export function parseExpectedBranchProtection(json) {
  const parsed = JSON.parse(json);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('expected branch protection must be an object keyed by branch');
  }

  const expected = {};
  for (const [branch, contexts] of Object.entries(parsed)) {
    if (!Array.isArray(contexts) || contexts.length === 0 || contexts.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error(`${branch}: expected contexts must be a non-empty string array`);
    }
    if (new Set(contexts).size !== contexts.length) {
      throw new Error(`${branch}: expected contexts contain duplicates`);
    }
    expected[branch] = [...contexts].sort();
  }
  if (Object.keys(expected).length === 0) {
    throw new Error('expected branch protection must name at least one branch');
  }
  return expected;
}

export function requiredStatusChecksApiArgs(repository, branch) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error(`invalid repository: ${repository}`);
  if (!branch) throw new Error('branch must not be empty');
  return [
    'api',
    '--method',
    'GET',
    `repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
  ];
}

export function compareBranchProtection(expected, actualByBranch) {
  const errors = [];
  for (const [branch, expectedContexts] of Object.entries(expected)) {
    const actual = actualByBranch[branch];
    if (!actual || typeof actual !== 'object') {
      errors.push(`${branch}: required status checks response is missing`);
      continue;
    }
    if (actual.strict !== true) {
      errors.push(`${branch}: strict must be true, got ${JSON.stringify(actual.strict)}`);
    }
    if (!Array.isArray(actual.contexts) || actual.contexts.some((item) => typeof item !== 'string')) {
      errors.push(`${branch}: actual contexts must be a string array`);
      continue;
    }
    const actualContexts = [...actual.contexts].sort();
    if (JSON.stringify(actualContexts) !== JSON.stringify(expectedContexts)) {
      errors.push(
        `${branch}: required contexts are ${JSON.stringify(actualContexts)}, expected ${JSON.stringify(expectedContexts)}`,
      );
    }
  }
  return errors;
}

function queryRequiredStatusChecks(repository, branch) {
  const result = spawnSync('gh', requiredStatusChecksApiArgs(repository, branch), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${branch}: gh could not read required status checks (${result.status ?? 'unknown'}): ` +
        String(result.stderr || result.stdout || '').trim(),
    );
  }
  return JSON.parse(result.stdout);
}

function main(argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const expectedIndex = argv.indexOf('--expected');
  const repoIndex = argv.indexOf('--repo');
  const expectedPath = expectedIndex >= 0
    ? path.resolve(argv[expectedIndex + 1])
    : path.join(repoRoot, '.github', 'branch-protection.expected.json');
  const repository = repoIndex >= 0 ? argv[repoIndex + 1] : DEFAULT_REPOSITORY;
  const expected = parseExpectedBranchProtection(readFileSync(expectedPath, 'utf8'));
  const actual = Object.fromEntries(
    Object.keys(expected).map((branch) => [branch, queryRequiredStatusChecks(repository, branch)]),
  );
  const errors = compareBranchProtection(expected, actual);

  if (errors.length > 0) {
    console.error('\n✗ Branch protection differs from the committed release policy:\n');
    for (const error of errors) console.error(`  • ${error}`);
    console.error('\nThis command only reads GitHub. Restore protection separately, then run release:check again.\n');
    return 1;
  }

  console.log(
    `✓ Branch protection matches ${path.relative(repoRoot, expectedPath)} for ` +
      `${Object.keys(expected).join(', ')} (strict required-status checks).`,
  );
  return 0;
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`branch-protection check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
