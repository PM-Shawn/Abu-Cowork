import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIM_TARGETS, BARE_SPECIFIER_SHIMS } from '../../../scripts/build-sidecar.mjs';
import {
  SHIM_THROW_KINDS as SCRIPT_SHIM_THROW_KINDS,
  findShimThrowKindViolations,
  inspectShimDirectory,
} from '../../../scripts/sidecar-shim-throw-kinds.mjs';
import { SHIM_THROW_KINDS } from './shimThrowKind';

// shimSurfaceTypes.ts can only name its pairs in static `import type`
// statements, so its list is a second copy of the build script's shim map.
// This test makes the two provably identical: a shim added to the build that
// nobody wired into the guard fails here, rather than going silently
// unchecked the way pluginFsRun's write options did for months.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const srcDir = path.join(repoRoot, 'src');

function expectedRealSpecifier(realAbsolutePath: string): string {
  return '@/' + path.relative(srcDir, realAbsolutePath).split(path.sep).join('/').replace(/\.tsx?$/, '');
}

function expectedShimSpecifier(shimAbsolutePath: string): string {
  return './' + path.basename(shimAbsolutePath).replace(/\.ts$/, '');
}

async function guardSpecifiers(): Promise<{ real: string[]; shim: string[] }> {
  const source = await readFile(path.join(here, 'shimSurfaceTypes.ts'), 'utf-8');
  const real: string[] = [];
  const shim: string[] = [];
  const importLine = /^import type \* as (real|shim)\w+ from '([^']+)';$/gm;
  for (const match of source.matchAll(importLine)) {
    (match[1] === 'real' ? real : shim).push(match[2]);
  }
  return { real, shim };
}

describe('shim surface guard coverage', () => {
  it('checks every shim the sidecar build swaps in, and nothing else', async () => {
    const { real, shim } = await guardSpecifiers();

    const expectedReal = [
      ...SHIM_TARGETS.map((t) => expectedRealSpecifier(t.real)),
      ...BARE_SPECIFIER_SHIMS.map((t) => t.specifier),
    ];
    const expectedShim = [
      ...SHIM_TARGETS.map((t) => expectedShimSpecifier(t.shim)),
      ...BARE_SPECIFIER_SHIMS.map((t) => expectedShimSpecifier(t.shim)),
    ];

    expect([...real].sort()).toEqual([...expectedReal].sort());
    expect([...shim].sort()).toEqual([...expectedShim].sort());
  });

  it('pairs each real module with its own shim, not another shim', async () => {
    const { real, shim } = await guardSpecifiers();
    const guardPairs = real.map((r, i) => `${r} -> ${shim[i]}`).sort();

    const buildPairs = [
      ...SHIM_TARGETS.map((t) => `${expectedRealSpecifier(t.real)} -> ${expectedShimSpecifier(t.shim)}`),
      ...BARE_SPECIFIER_SHIMS.map((t) => `${t.specifier} -> ${expectedShimSpecifier(t.shim)}`),
    ].sort();

    expect(guardPairs).toEqual(buildPairs);
  });
});

// 用抛出错误顶替一段功能的 shim 曾经随版本发出去（用量记录约六周没有记上）。
// 下面的断言要求本目录里每个会抛出错误的文件都写明自己属于哪一类，
// 发版检查再根据分类拦住 `feature-gap`。分类的含义见 `shimThrowKind.ts`。
describe('shim throw kinds', () => {
  it('classifies every shim file that throws, and only those', () => {
    expect(findShimThrowKindViolations(inspectShimDirectory(here))).toEqual([]);
  });

  it('inspects every file the build swaps in', () => {
    // 打包脚本登记的 shim 放在本目录之外，或者用了检查不认识的扩展名，都会在这里失败。
    const inspected = new Set(inspectShimDirectory(here).map((entry) => entry.file));
    const notInspected = [...SHIM_TARGETS, ...BARE_SPECIFIER_SHIMS]
      .map((t) => path.relative(here, t.shim).split(path.sep).join('/'))
      .filter((file) => !inspected.has(file));

    expect(notInspected).toEqual([]);
  });

  it('keeps the kind list of the type and of the release check identical', () => {
    expect([...SHIM_THROW_KINDS]).toEqual(SCRIPT_SHIM_THROW_KINDS);
  });
});
