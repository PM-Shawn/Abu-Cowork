import { format, getI18n } from '../../i18n';

/**
 * 模型点了一个本轮没给它的工具名时，附在错误后面的一句：列出本轮给过它的工具，
 * 排序、去重。运行时没有写入名单（或名单为空）时返回 null，调用方保留原来的错误。
 */
export function offeredToolsHint(offered: readonly string[] | undefined): string | null {
  if (!offered || offered.length === 0) return null;
  const names = [...new Set(offered)].sort().join(', ');
  return format(getI18n().toolResult.system.unknownToolAvailable, { names });
}

/** 被拒绝的工具名不在本轮名单里时，在错误后面附上可用的工具。 */
export function withOfferedToolsHint(
  error: string,
  name: string,
  offered: readonly string[] | undefined,
): string {
  if (offered?.includes(name)) return error;
  const hint = offeredToolsHint(offered);
  return hint ? `${error}. ${hint}` : error;
}
