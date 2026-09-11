/**
 * Global setup for the real-Electron E2E smoke suite.
 *
 *  1. Prepares the pinned Electron runtimes, built-in browser runtime, and
 *     native helper used by capability, browser, and Computer Use checks.
 *  2. Rebuilds the sidecar from the current worktree sources so Electron
 *     never exercises a stale ignored sidecar/index.mjs bundle.
 *  3. Rebuilds dist-electron-spike/ from the current renderer sources so the
 *     Electron shell and sidecar are always tested as one current-source unit.
 *
 * Every launch uses its own Chromium profile, app-data root, and random
 * loopback ports. Do not kill processes by PID here: a stale process cannot
 * win another test's single-instance lock, while PID lookup can race with
 * process exit and affect an unrelated process.
 *
 * macOS has no `timeout` binary (see feedback-macos-no-timeout-binary in
 * project memory) — everything here is synchronous / self-terminating, no
 * reliance on a `timeout` wrapper.
 */
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const { withoutLiveEvalCredential } = createRequire(import.meta.url)('../../scripts/computer-use-live-eval.cjs') as {
  withoutLiveEvalCredential: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

const REPO_ROOT = process.cwd();
const BUNDLED_NODE_DIR = path.join(
  REPO_ROOT,
  'electron',
  '.runtime',
  'node-runtime',
  process.platform === 'win32' ? '' : 'bin',
);
const BUNDLED_NODE = path.join(
  BUNDLED_NODE_DIR,
  process.platform === 'win32' ? 'node.exe' : 'node',
);

function bundledNodeEnv(): NodeJS.ProcessEnv {
  return {
    ...withoutLiveEvalCredential(process.env),
    PATH: `${BUNDLED_NODE_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

export default async function globalSetup(): Promise<void> {
  console.log('[e2e:global-setup] preparing Electron and browser runtimes...');
  // This bootstrap is intentionally the only command allowed to use the
  // developer's system Node. It installs/verifies the pinned repository Node;
  // every build below must then use that runtime so an old global Node cannot
  // accidentally launch Vite or another build tool.
  execSync('npm run setup:electron-runtimes', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: withoutLiveEvalCredential(process.env),
  });
  const runtimeEnv = bundledNodeEnv();
  execSync(
    'npm run verify:electron-runtimes && npm run build:electron-browser-runtime && npm run build:native-helper',
    {
      cwd: REPO_ROOT,
      env: runtimeEnv,
      stdio: 'inherit',
    },
  );

  console.log('[e2e:global-setup] building sidecar from current sources…');
  execSync('npm run build:sidecar', {
    cwd: REPO_ROOT,
    env: runtimeEnv,
    stdio: 'inherit',
  });

  console.log('[e2e:global-setup] building renderer from current sources…');
  execFileSync(BUNDLED_NODE, [
    path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
    '--base=./',
    '--outDir',
    'dist-electron-spike',
  ], {
    cwd: REPO_ROOT,
    env: runtimeEnv,
    stdio: 'inherit',
  });
}
