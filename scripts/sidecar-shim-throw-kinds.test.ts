import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_BLOCKING_SHIM_THROW_KINDS,
  SHIM_THROW_KINDS,
  findReleaseBlockingShims,
  findShimThrowKindViolations,
  inspectShimDirectory,
  inspectShimSource,
  type ShimThrowEntry,
} from './sidecar-shim-throw-kinds.mjs';

// 临时目录放在仓库根目录下的 `.scratch/`，不用系统临时目录。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'sidecar-shim-throw-kinds-tests');

let caseIndex = 0;
let caseRoot = '';

function write(relativePath: string, content: string): void {
  const full = path.join(caseRoot, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function entry(file: string, overrides: Partial<ShimThrowEntry>): ShimThrowEntry {
  return { file, throws: false, declared: false, kind: null, ...overrides };
}

beforeEach(() => {
  caseIndex += 1;
  caseRoot = path.join(SCRATCH_ROOT, `case-${caseIndex}`);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(caseRoot, 'shims'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe('sidecar shim throw kinds', () => {
  describe('inspectShimSource', () => {
    it('finds a throw statement at any depth', () => {
      const source = `
        export function getReader() {
          return { read: () => { if (!ready) { throw new Error('not wired'); } } };
        }
      `;

      expect(inspectShimSource('readerRun.ts', source).throws).toBe(true);
    });

    it('finds a throw inside a class method and a getter', () => {
      const method = "export class Port { read(): never { throw new Error('not wired'); } }";
      const getter = "export const port = { get value(): never { throw new Error('not wired'); } };";

      expect(inspectShimSource('portRun.ts', method).throws).toBe(true);
      expect(inspectShimSource('portRun.ts', getter).throws).toBe(true);
    });

    it('counts a rethrow of a caught error', () => {
      const source = `
        export async function exists(p: string) {
          try { await access(p); return true; } catch (err) { if (isEnoent(err)) return false; throw err; }
        }
      `;

      expect(inspectShimSource('fsRun.ts', source).throws).toBe(true);
    });

    it('counts Promise.reject, which a caller cannot tell apart from a throw', () => {
      const source = "export function trackUsage() { return Promise.reject(new Error('not available')); }";

      expect(inspectShimSource('usageRun.ts', source).throws).toBe(true);
    });

    it('ignores the word throw in comments and strings', () => {
      const source = `
        /** This shim must be defensive, not throw: a drain outside a run is skipped. */
        export function drain(): string {
          // never throw here, never Promise.reject(...) either
          return 'would throw new Error() elsewhere';
        }
      `;

      expect(inspectShimSource('queueRun.ts', source)).toEqual({
        throws: false,
        declared: false,
        kind: null,
        reexports: [],
      });
    });

    it('reads the classification from an exported const string literal', () => {
      const source = `
        import type { ShimThrowKind } from './shimThrowKind';
        export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';
        export function setPort(): void { throw new Error('wiring bug'); }
      `;

      expect(inspectShimSource('portRun.ts', source)).toMatchObject({
        throws: true,
        declared: true,
        kind: 'wiring-guard',
      });
    });

    it('reports a classification that is not a plain string literal as declared without a kind', () => {
      const computed = `
        const kind = 'wiring-guard';
        export const SHIM_THROW_KIND = kind;
        export function setPort(): void { throw new Error('wiring bug'); }
      `;
      const template = 'export const SHIM_THROW_KIND = `feature-gap`;';
      const asserted = "export const SHIM_THROW_KIND = 'feature-gap' as const;";

      expect(inspectShimSource('portRun.ts', computed)).toMatchObject({ throws: true, declared: true, kind: null });
      expect(inspectShimSource('portRun.ts', template)).toMatchObject({ declared: true, kind: null });
      expect(inspectShimSource('portRun.ts', asserted)).toMatchObject({ declared: true, kind: null });
    });

    it('does not accept a constant that is not an exported top-level const', () => {
      const notExported = "const SHIM_THROW_KIND = 'wiring-guard';";
      const notConst = "export let SHIM_THROW_KIND = 'wiring-guard';";
      const nested = "export function f() { const SHIM_THROW_KIND = 'wiring-guard'; return SHIM_THROW_KIND; }";
      const renamed = "const kind = 'wiring-guard'; export { kind as SHIM_THROW_KIND };";

      for (const source of [notExported, notConst, nested, renamed]) {
        expect(inspectShimSource('portRun.ts', source).declared).toBe(false);
      }
    });

    it('lists relative value re-exports and skips aliased and type-only ones', () => {
      const source = `
        export { isActive } from '../entitlementMirror';
        export * from './helpers';
        export { extract } from '@/core/memdir/extractor';
        export type { Options } from '../types';
      `;

      expect(inspectShimSource('forwardRun.ts', source).reexports).toEqual(['../entitlementMirror', './helpers']);
    });
  });

  describe('inspectShimDirectory', () => {
    it('inspects every source extension, skips tests and declaration files', () => {
      const throwing = "export function f(): never { throw new Error('x'); }\n";
      for (const name of ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.mjs', 'g.cjs', 'nested/h.ts']) {
        write(`shims/${name}`, throwing);
      }
      write('shims/a.test.ts', throwing);
      write('shims/i.contract.test.ts', throwing);
      write('shims/types.d.ts', 'export declare const x: number;\n');
      write('shims/notes.md', 'throw');

      const entries = inspectShimDirectory(path.join(caseRoot, 'shims'));

      expect(entries.map((e) => e.file)).toEqual(['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.mjs', 'g.cjs', 'nested/h.ts']);
      expect(entries.every((e) => e.throws)).toBe(true);
    });

    it('treats a shim as throwing when a local module it re-exports throws', () => {
      write('usageStub.ts', "export function trackUsage(): never { throw new Error('not available'); }\n");
      write('shims/usageRun.ts', "export { trackUsage } from '../usageStub';\n");

      expect(inspectShimDirectory(path.join(caseRoot, 'shims'))).toEqual([
        entry('usageRun.ts', { throws: true }),
      ]);
    });

    it('follows re-exports through more than one module', () => {
      write('deep.ts', "export function trackUsage() { return Promise.reject(new Error('not available')); }\n");
      write('middle.ts', "export * from './deep';\n");
      write('shims/usageRun.ts', "export { trackUsage } from '../middle';\n");

      expect(inspectShimDirectory(path.join(caseRoot, 'shims'))[0].throws).toBe(true);
    });

    it('does not count a re-exported module that neither throws nor rejects', () => {
      write('mirror.ts', 'export function isActive(): boolean { return false; }\n');
      write('shims/entitlementRun.ts', "export { isActive } from '../mirror';\n");

      expect(inspectShimDirectory(path.join(caseRoot, 'shims'))).toEqual([entry('entitlementRun.ts', {})]);
    });

    it('stops on modules that re-export each other', () => {
      write('shims/a.ts', "export * from './b';\n");
      write('shims/b.ts', "export * from './a';\n");

      expect(inspectShimDirectory(path.join(caseRoot, 'shims')).map((e) => e.throws)).toEqual([false, false]);
    });

    it('fails on a re-export that does not resolve to a file', () => {
      write('shims/usageRun.ts', "export { trackUsage } from '../missing';\n");

      expect(() => inspectShimDirectory(path.join(caseRoot, 'shims'))).toThrow(/re-exports "\.\.\/missing"/);
    });
  });

  describe('findShimThrowKindViolations', () => {
    it('accepts classified throwing files and unclassified non-throwing files', () => {
      const entries = [
        entry('portRun.ts', { throws: true, declared: true, kind: 'wiring-guard' }),
        entry('axRun.ts', { throws: true, declared: true, kind: 'shell-side' }),
        entry('fsRun.ts', { throws: true, declared: true, kind: 'input-check' }),
        entry('usageRun.ts', { throws: true, declared: true, kind: 'feature-gap' }),
        entry('platformRun.ts', {}),
      ];

      expect(findShimThrowKindViolations(entries)).toEqual([]);
    });

    it('reports a throwing file with no classification', () => {
      const violations = findShimThrowKindViolations([entry('usageRun.ts', { throws: true })]);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('usageRun.ts throws or rejects');
      expect(violations[0]).toContain('does not export SHIM_THROW_KIND');
    });

    it('reports a classification on a file that does not throw', () => {
      const violations = findShimThrowKindViolations([
        entry('platformRun.ts', { declared: true, kind: 'wiring-guard' }),
      ]);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('platformRun.ts exports SHIM_THROW_KIND but neither throws nor rejects');
    });

    it('reports a classification that is not a plain string literal', () => {
      const violations = findShimThrowKindViolations([entry('portRun.ts', { throws: true, declared: true })]);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('portRun.ts must set SHIM_THROW_KIND to a plain string literal');
    });

    it('reports a value outside the four kinds', () => {
      const violations = findShimThrowKindViolations([
        entry('portRun.ts', { throws: true, declared: true, kind: 'dead-code' }),
      ]);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('portRun.ts sets SHIM_THROW_KIND to "dead-code"');
    });
  });

  describe('findReleaseBlockingShims', () => {
    it('blocks only feature-gap', () => {
      expect(RELEASE_BLOCKING_SHIM_THROW_KINDS).toEqual(['feature-gap']);

      const blockers = findReleaseBlockingShims(
        SHIM_THROW_KINDS.map((kind) => entry(`${kind}Run.ts`, { throws: true, declared: true, kind })),
      );

      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain('feature-gapRun.ts is classified "feature-gap"');
    });

    it('lets a tree with no feature-gap through', () => {
      const entries = [
        entry('portRun.ts', { throws: true, declared: true, kind: 'wiring-guard' }),
        entry('platformRun.ts', {}),
      ];

      expect(findReleaseBlockingShims(entries)).toEqual([]);
    });
  });
});
