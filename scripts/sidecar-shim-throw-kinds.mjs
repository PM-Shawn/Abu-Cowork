/**
 * 读取 `sidecar/src/shims/` 下每个文件的抛出错误分类，供两处使用：
 *
 *   - `sidecar/src/shims/shimSurfaceCoverage.test.ts`（随 `npm run verify` 运行）
 *     断言会抛出错误的文件都导出了分类常量；
 *   - `scripts/release-preflight.mjs`（`npm run release:check`，推 tag 之后 CI 的
 *     第一步）遇到 `feature-gap` 就让发版失败。
 *
 * 分类值的含义写在 `sidecar/src/shims/shimThrowKind.ts`。
 *
 * 一个文件算作「会抛出错误」，是指下面任意一条成立：
 *   - 文件里有 `throw` 语句；
 *   - 文件里有 `Promise.reject(...)` 调用（对 `await` 与 `.catch()` 来说它与
 *     `throw` 的效果相同）；
 *   - 文件用 `export … from '<相对路径>'` 转出的本地模块满足上面两条之一，
 *     转出关系逐层往下跟。
 *
 * 判断都用 TypeScript 编译器 API 读语法树，注释和字符串里出现的 throw 字样不计入。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** shim 文件用这个名字导出自己的分类。 */
export const SHIM_THROW_KIND_EXPORT = 'SHIM_THROW_KIND';

/** 全部分类值，与 `sidecar/src/shims/shimThrowKind.ts` 的 `SHIM_THROW_KINDS` 逐项相同。 */
export const SHIM_THROW_KINDS = ['wiring-guard', 'shell-side', 'input-check', 'feature-gap'];

/** 带有这些分类的 shim 不允许随版本发出去。 */
export const RELEASE_BLOCKING_SHIM_THROW_KINDS = ['feature-gap'];

/** 会被打包进 sidecar 的源码扩展名。 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function isSourceFile(name) {
  if (/\.d\.[cm]?ts$/.test(name)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(name)) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function scriptKindOf(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isPromiseReject(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Promise' &&
    node.expression.name.text === 'reject'
  );
}

function containsFailure(node) {
  if (ts.isThrowStatement(node) || isPromiseReject(node)) return true;
  return ts.forEachChild(node, containsFailure) ?? false;
}

function isExported(statement) {
  return (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * 检查一个 shim 文件的源码，只看这个文件自己。
 *
 * - `throws`：文件里有没有 `throw` 语句或 `Promise.reject(...)` 调用，位置不限
 *   （顶层、函数体、类的方法、回调里都算）。
 * - `declared`：有没有在顶层写 `export const SHIM_THROW_KIND = ...`。
 * - `kind`：常量的值。常量必须直接写成字符串字面量；写成别的表达式时为 `null`。
 * - `reexports`：`export … from '<相对路径>'` 里的相对路径，按出现顺序。
 */
export function inspectShimSource(fileName, sourceText) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKindOf(fileName));

  let declared = false;
  let kind = null;
  const reexports = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.') && !statement.isTypeOnly) reexports.push(specifier);
      continue;
    }
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== SHIM_THROW_KIND_EXPORT) continue;
      declared = true;
      if (declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
        kind = declaration.initializer.text;
      }
    }
  }

  return { throws: containsFailure(source), declared, kind, reexports };
}

function listShimFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listShimFiles(full));
    else if (isSourceFile(entry.name)) files.push(full);
  }
  return files;
}

/** 把 `export … from` 里的相对路径解析成磁盘上的文件；找不到就抛出错误。 */
function resolveReexport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`[sidecar-shim-throw-kinds] ${fromFile} re-exports "${specifier}", which does not resolve to a file`);
  return found;
}

/** 沿着相对路径的转出关系逐层往下，任何一层会抛出错误就算数。 */
function reexportedModuleThrows(fromFile, reexports, visited) {
  for (const specifier of reexports) {
    const target = resolveReexport(fromFile, specifier);
    if (visited.has(target)) continue;
    visited.add(target);
    const inspected = inspectShimSource(target, readFileSync(target, 'utf8'));
    if (inspected.throws || reexportedModuleThrows(target, inspected.reexports, visited)) return true;
  }
  return false;
}

/**
 * 检查 shim 目录下全部非测试的源码文件，按文件名排序返回。
 * `throws` 在这里包含经由 `export … from` 转出的本地模块。
 */
export function inspectShimDirectory(shimsDir) {
  return listShimFiles(shimsDir)
    .map((full) => {
      const own = inspectShimSource(full, readFileSync(full, 'utf8'));
      return {
        file: path.relative(shimsDir, full).split(path.sep).join('/'),
        throws: own.throws || reexportedModuleThrows(full, own.reexports, new Set([full])),
        declared: own.declared,
        kind: own.kind,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** 分类常量写得不合规的文件，每条一句说明；全部合规时返回空数组。 */
export function findShimThrowKindViolations(entries) {
  const violations = [];
  for (const entry of entries) {
    if (entry.throws && !entry.declared) {
      violations.push(
        `${entry.file} throws or rejects (itself, or through a module it re-exports) but does not export ` +
          `${SHIM_THROW_KIND_EXPORT} — classify it as one of: ${SHIM_THROW_KINDS.join(', ')} ` +
          '(see sidecar/src/shims/shimThrowKind.ts)',
      );
    } else if (!entry.throws && entry.declared) {
      violations.push(`${entry.file} exports ${SHIM_THROW_KIND_EXPORT} but neither throws nor rejects — remove the export`);
    } else if (entry.declared && entry.kind === null) {
      violations.push(`${entry.file} must set ${SHIM_THROW_KIND_EXPORT} to a plain string literal`);
    } else if (entry.declared && !SHIM_THROW_KINDS.includes(entry.kind)) {
      violations.push(
        `${entry.file} sets ${SHIM_THROW_KIND_EXPORT} to "${entry.kind}", which is not one of: ${SHIM_THROW_KINDS.join(', ')}`,
      );
    }
  }
  return violations;
}

/** 分类属于阻止发版那一类的文件，每条一句说明。 */
export function findReleaseBlockingShims(entries) {
  return entries
    .filter((entry) => RELEASE_BLOCKING_SHIM_THROW_KINDS.includes(entry.kind))
    .map(
      (entry) =>
        `${entry.file} is classified "${entry.kind}": the sidecar is missing a capability a user path needs, ` +
        'and the throw would turn into a silent loss. Implement it before releasing.',
    );
}

/** 发版检查用：分类不合规与阻止发版的 shim 合在一起返回。 */
export function checkShimThrowKindsForRelease(shimsDir) {
  const entries = inspectShimDirectory(shimsDir);
  return [...findShimThrowKindViolations(entries), ...findReleaseBlockingShims(entries)];
}
