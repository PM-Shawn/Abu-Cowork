/**
 * `sidecar-shim-throw-kinds.mjs` 的类型声明。脚本是纯 JavaScript，TypeScript 写的
 * 测试引用它时需要这份声明，否则会按 `any` 处理并在 `noImplicitAny` 下报错。
 */

/** 一个 shim 文件自身的检查结果。 */
export interface ShimThrowInspection {
  /** 文件里有没有 `throw` 语句或 `Promise.reject(...)` 调用。 */
  throws: boolean;
  /** 有没有在顶层导出 `SHIM_THROW_KIND`。 */
  declared: boolean;
  /** 常量的值；没有导出，或者没有直接写成字符串字面量时为 `null`。 */
  kind: string | null;
  /** `export … from '<相对路径>'` 里的相对路径。 */
  reexports: string[];
}

/** 目录检查的一行：`throws` 包含经由 `export … from` 转出的本地模块。 */
export interface ShimThrowEntry {
  /** 相对于 shim 目录的文件名，分隔符统一为 `/`。 */
  file: string;
  throws: boolean;
  declared: boolean;
  kind: string | null;
}

export const SHIM_THROW_KIND_EXPORT: string;
export const SHIM_THROW_KINDS: string[];
export const RELEASE_BLOCKING_SHIM_THROW_KINDS: string[];

export function inspectShimSource(fileName: string, sourceText: string): ShimThrowInspection;
export function inspectShimDirectory(shimsDir: string): ShimThrowEntry[];
export function findShimThrowKindViolations(entries: ShimThrowEntry[]): string[];
export function findReleaseBlockingShims(entries: ShimThrowEntry[]): string[];
export function checkShimThrowKindsForRelease(shimsDir: string): string[];
