interface TruncationRule {
  headLines: number;
  tailLines: number;
  maxChars: number;
}

/**
 * POC 说明：Abu 原仓库这里引用 `../tools/toolNames` 常量。
 * `tools/` 模块尚未迁移进 @abu/core，所以这里先内联 tool 名字为字符串。
 * tools 模块迁移后统一走 ToolNamesRegistry。
 */
const TRUNCATION_RULES: Record<string, TruncationRule> = {
  read_file: { headLines: 150, tailLines: 20, maxChars: 15000 },
  list_directory: { headLines: 100, tailLines: 0, maxChars: 8000 },
  run_command: { headLines: 150, tailLines: 30, maxChars: 15000 },
  search_files: { headLines: 50, tailLines: 0, maxChars: 8000 },
  find_files: { headLines: 100, tailLines: 0, maxChars: 8000 },
  web_search: { headLines: 0, tailLines: 0, maxChars: 8000 },
};

const DEFAULT_RULE: TruncationRule = { headLines: 0, tailLines: 0, maxChars: 3500 };

export function getContextPressureScale(contextUsagePercent?: number): number {
  if (contextUsagePercent === undefined) return 1.0;
  if (contextUsagePercent < 50) return 1.0;
  if (contextUsagePercent < 70) return 0.7;
  if (contextUsagePercent < 85) return 0.4;
  return 0.25;
}

export function truncateToolResult(
  toolName: string,
  result: string,
  contextUsagePercent?: number
): string {
  if (!result) return result;

  const baseRule = TRUNCATION_RULES[toolName] || DEFAULT_RULE;
  const scale = getContextPressureScale(contextUsagePercent);

  const rule: TruncationRule =
    scale < 1.0
      ? {
          headLines: Math.max(20, Math.floor(baseRule.headLines * scale)),
          tailLines: Math.max(5, Math.floor(baseRule.tailLines * scale)),
          maxChars: Math.max(1500, Math.floor(baseRule.maxChars * scale)),
        }
      : baseRule;

  if (result.length <= rule.maxChars) return result;

  if (rule.headLines > 0) {
    const lines = result.split('\n');
    if (lines.length > rule.headLines + rule.tailLines + 1) {
      const head = lines.slice(0, rule.headLines);
      const tail = rule.tailLines > 0 ? lines.slice(-rule.tailLines) : [];
      const omitted = lines.length - rule.headLines - rule.tailLines;
      const truncated = [
        ...head,
        `\n[... ${omitted} lines omitted ...]\n`,
        ...tail,
      ].join('\n');
      if (truncated.length > rule.maxChars) return charTruncate(truncated, rule.maxChars);
      return truncated;
    }
  }

  return charTruncate(result, rule.maxChars);
}

function charTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tailChars = Math.min(500, Math.floor(maxChars * 0.15));
  const headChars = maxChars - tailChars - 50;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  return `${head}\n\n[... ${omitted} characters omitted ...]\n\n${tail}`;
}
