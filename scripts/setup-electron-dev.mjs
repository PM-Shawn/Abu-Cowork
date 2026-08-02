import { existsSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const nodeModulesPath = path.join(repoRoot, 'node_modules');

if (existsSync(nodeModulesPath) && lstatSync(nodeModulesPath).isSymbolicLink()) {
  console.error(
    [
      '',
      '[Abu Electron] 当前 node_modules 是软链接。',
      '为避免 npm ci 删除或修改其他 worktree 的共享依赖，安装已停止。',
      '请为当前 worktree 使用独立的 node_modules 目录后再运行此命令。',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = npmExecPath
  ? [npmExecPath, 'ci', '--include=dev', '--no-audit', '--no-fund']
  : ['ci', '--include=dev', '--no-audit', '--no-fund'];

console.log('[Abu Electron] 正在按 package-lock.json 安装当前 worktree 的完整依赖...');
const childEnv = { ...process.env, NODE_ENV: 'development' };

function run(commandArgs, label) {
  console.log(`\n[Abu Electron] ${label}...`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[Abu Electron] ${label}启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmArgs(...npmArguments) {
  return npmExecPath ? [npmExecPath, ...npmArguments] : npmArguments;
}

run(args, '安装锁定依赖');
run(npmArgs('run', 'setup:electron-runtimes'), '准备内置 Node 和 Python');
run(npmArgs('run', 'verify:electron-runtimes'), '校验内置运行时');
run(npmArgs('run', 'build:electron-browser-runtime'), '构建浏览器能力');
run(npmArgs('run', 'build:sidecar'), '构建 Agent sidecar');
run(npmArgs('run', 'build:native-helper'), '构建电脑操控辅助程序');
run(npmArgs('run', 'build:sandbox-launcher'), '构建沙箱启动器');
run(npmArgs('run', 'build:electron:renderer'), '构建 Electron 前端');

const preflight = spawnSync(
  process.execPath,
  [path.join(scriptDir, 'electron-dev-preflight.mjs')],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  }
);

if (preflight.status === 0) {
  console.log('\n[Abu Electron] 开发环境已准备完成，可运行 npm run electron:dev。');
}
process.exit(preflight.status ?? 1);
