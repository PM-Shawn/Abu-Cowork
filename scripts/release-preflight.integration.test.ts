import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 发版检查对 sidecar shim 分类的反向验证：把一个真实的 shim 人为标成 `feature-gap`，
// 真实的 `release-preflight.mjs` 必须以非零退出码结束。脚本按当前工作目录读取版本号、
// 更新日志与 shim，所以每条用例先搭一个最小的项目目录，再在里面启动脚本。
// 项目目录放在仓库根目录下的 `.scratch/`，不用系统临时目录。

const here = path.dirname(fileURLToPath(import.meta.url));
const preflightScript = path.join(here, 'release-preflight.mjs');
const realShimsDir = path.resolve(here, '../sidecar/src/shims');
const scratchRoot = path.resolve(here, '../.scratch/release-preflight-tests');

const VERSION = '1.2.3';
let caseIndex = 0;

function write(root: string, relativePath: string, content: string): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** 版本号与两份更新日志都合规的项目目录，shim 目录为空。 */
function makeProject(): string {
  caseIndex += 1;
  const root = path.join(scratchRoot, `case-${caseIndex}`);
  fs.rmSync(root, { recursive: true, force: true });
  write(root, 'package.json', JSON.stringify({ version: VERSION }));
  write(root, 'package-lock.json', JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }));
  write(root, 'src-tauri/tauri.conf.json', JSON.stringify({ version: VERSION }));
  write(root, 'src-tauri/Cargo.toml', `[package]\nname = "abu"\nversion = "${VERSION}"\n`);
  write(root, 'src-tauri/Cargo.lock', `[[package]]\nname = "abu"\nversion = "${VERSION}"\n`);
  write(root, 'CHANGELOG.md', `## v${VERSION}\n\n- Fixed a thing.\n`);
  write(root, 'CHANGELOG.zh-CN.md', `## v${VERSION}\n\n- 修复了一个问题。\n`);
  fs.mkdirSync(path.join(root, 'sidecar/src/shims'), { recursive: true });
  return root;
}

/**
 * 把仓库里真实的 `sidecar/src` 源文件复制进项目目录，测试文件不复制。
 * shim 会用 `export … from '../x'` 转出 `sidecar/src` 下的模块，检查要跟到那些文件，
 * 所以连同上一级目录一起复制。
 */
function copyRealShims(root: string): void {
  fs.cpSync(path.dirname(realShimsDir), path.join(root, 'sidecar/src'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  });
}

/** 按发版 CI 的方式启动脚本：在 GitHub Actions 里显式跳过分支保护的读取。 */
function runPreflight(root: string, tag = `v${VERSION}`): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [preflightScript, '--tag', tag, '--skip-branch-protection'], {
    cwd: root,
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('release preflight: sidecar shim throw kinds', { timeout: 60_000 }, () => {
  it('passes with the shims this repository ships', () => {
    const root = makeProject();
    copyRealShims(root);

    const { status, output } = runPreflight(root);

    expect(output).toContain(`Release preflight passed for v${VERSION}`);
    expect(status).toBe(0);
  });

  it('fails when a shipped shim is relabelled feature-gap', () => {
    const root = makeProject();
    copyRealShims(root);
    const target = path.join(root, 'sidecar/src/shims/abortRegistryRun.ts');
    const original = fs.readFileSync(target, 'utf8');
    const relabelled = original.replace(
      "export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';",
      "export const SHIM_THROW_KIND: ShimThrowKind = 'feature-gap';",
    );
    expect(relabelled).not.toBe(original);
    fs.writeFileSync(target, relabelled);

    const { status, output } = runPreflight(root);

    expect(status).toBe(1);
    expect(output).toContain('Release preflight FAILED');
    expect(output).toContain('sidecar shim: abortRegistryRun.ts is classified "feature-gap"');
  });

  it('fails on a pre-release tag as well', () => {
    const root = makeProject();
    write(
      root,
      'sidecar/src/shims/usageTrackerRun.ts',
      "export const SHIM_THROW_KIND = 'feature-gap';\nexport function trackUsage(): never { throw new Error('not available'); }\n",
    );

    const { status, output } = runPreflight(root, `v${VERSION}-rc1`);

    expect(status).toBe(1);
    expect(output).toContain('sidecar shim: usageTrackerRun.ts is classified "feature-gap"');
  });

  it('fails when a shim throws without a classification', () => {
    const root = makeProject();
    write(
      root,
      'sidecar/src/shims/usageTrackerRun.ts',
      "export function trackUsage(): never { throw new Error('not available in the sidecar'); }\n",
    );

    const { status, output } = runPreflight(root);

    expect(status).toBe(1);
    expect(output).toContain('sidecar shim: usageTrackerRun.ts throws or rejects');
    expect(output).toContain('does not export SHIM_THROW_KIND');
  });

  it('fails when a shim forwards to a local module that throws, without a classification', () => {
    const root = makeProject();
    write(root, 'sidecar/src/usageStub.ts', "export function trackUsage(): never { throw new Error('not available'); }\n");
    write(root, 'sidecar/src/shims/usageTrackerRun.ts', "export { trackUsage } from '../usageStub';\n");

    const { status, output } = runPreflight(root);

    expect(status).toBe(1);
    expect(output).toContain('sidecar shim: usageTrackerRun.ts throws or rejects');
  });
});
