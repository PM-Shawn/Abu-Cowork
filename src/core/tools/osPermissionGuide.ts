/**
 * OS-permission-guide helpers — a PURE, store-free module.
 *
 * When a file tool fails with an OS-level permission denial (macOS TCC /
 * Windows ACL), we append a friendly grant-guide telling the user how to
 * authorize Abu, instead of surfacing a raw `EACCES`/`EPERM` string.
 *
 * This lives in its own module (not inside `registry.ts`) for ONE reason: the
 * sidecar's local-execution path (`sidecar/src/localTools/index.ts`'s
 * `executeLocalTool`) must apply the EXACT same guide the reverse
 * `executeAnyTool` path (registry.ts) does — but `registry.ts` statically
 * imports `useChatStore` (and mcpManager, i18n, …), so importing anything FROM
 * it drags `src/stores/chatStore.ts` into the sidecar bundle, which the
 * `build:sidecar` fail-fast guard forbids (src/stores/** must never be
 * reachable from `sidecar/src/main.ts`). Extracting the guide logic into this
 * pure module (same discipline as `settingsSelectors.ts`) lets BOTH paths share
 * one implementation with zero store coupling. Its only imports are
 * `platform.ts` (`isWindows`, already sidecar-safe) and `toolNames.ts` (pure
 * constants).
 */
import { isWindows } from '../../utils/platform';
import { TOOL_NAMES } from './toolNames';

/**
 * The file tools whose OS-permission errors get the grant-guide. Mirrors the
 * keys of `registry.ts`'s `FILE_TOOL_PATH_MAP` (same `TOOL_NAMES.*` set).
 * `registry.test.ts` asserts the two stay in sync so a newly-added file tool
 * can't silently miss the guide.
 */
export const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.EDIT_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
]);

export function isFileToolName(name: string): boolean {
  return FILE_TOOL_NAMES.has(name);
}

export function isOSPermissionError(result: string): boolean {
  return /operation not permitted|EACCES|EPERM|access is denied/i.test(result);
}

export function formatOSPermissionGuide(originalError: string): string {
  if (isWindows()) {
    return `${originalError}\n\n系统未授权阿布访问此位置。请以管理员身份运行 Abu，或检查文件夹权限设置。`;
  }
  return `${originalError}\n\nmacOS 系统未授权阿布访问此位置。请前往「系统设置 → 隐私与安全性 → 文件和文件夹」中授权 Abu，然后重启 Abu。`;
}

/**
 * Apply the friendly OS-permission-grant guide to a file tool's string result
 * when it looks like an OS-level permission denial, else return the result
 * unchanged. Shared by `executeAnyTool` (registry.ts, reverse path) and
 * `executeLocalTool` (sidecar, local-execution path) so a file-tool permission
 * error emits the identical guided message regardless of which path ran it.
 */
export function applyOSPermissionGuideIfNeeded(name: string, result: string): string {
  if (isFileToolName(name) && isOSPermissionError(result)) {
    return formatOSPermissionGuide(result);
  }
  return result;
}
