import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { LocalServerKind } from '../llm/localProvider';
import { calculateSafetyMargin } from '../context/contextManager';

const SERVICE_NAMES: Record<LocalServerKind, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'custom-local': 'LM Studio / Ollama',
};

/** 窗口放不下系统说明加工具定义、或超长恢复后仍放不下时，回答里的那句话。 */
export function contextTooSmallMessage(chat: TranslationDict['chat'], kind: LocalServerKind | null): string {
  return kind === null
    ? chat.contextFixedTooLarge
    : format(chat.contextFixedTooLargeLocal, { service: SERVICE_NAMES[kind] });
}

/** 同上，但带数字：说明需要多少 tokens、模型窗口只有多少。 */
export function contextTooSmallMessageWithNumbers(
  chat: TranslationDict['chat'],
  kind: LocalServerKind | null,
  neededTokens: number,
  windowTokens: number,
): string {
  const args = {
    needed: formatTokenCount(neededTokens),
    window: formatTokenCount(windowTokens),
  };
  return kind === null
    ? format(chat.contextFixedTooLargeWithNumbers, args)
    : format(chat.contextFixedTooLargeWithNumbersLocal, { ...args, service: SERVICE_NAMES[kind] });
}

/** 界面上的长度写法：8192 → 8K、131072 → 128K、1048576 → 1M。 */
export function formatTokenCount(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  if (tokens % 1024 === 0) return `${(tokens / 1024).toFixed(0)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * Ollama num_ctx 自救的取值：放不下固定开销时，需要多大的窗口才装得下。
 *
 * `fixedTokens`（系统说明 + 工具 schema）是 throw 时量到的数，`spentBudget`
 * 是当时的可用输入预算——两者都随 ContextBudgetError 带出来。目标值在
 * fixedTokens 之上留出正常对话的输入空间（预算的 1/4，至少 4k），按 1024
 * 对齐，并 clamp 进 [下限, 上限]：太小救不了、太大撑爆显存。
 *
 * 返回 null 表示算不出有意义的值（输入异常）——调用方落到下一级自救。
 */
export function planOllamaNumCtx(
  fixedTokens: number,
  spentBudget: number,
  limits: { min: number; max: number },
): number | null {
  if (!(fixedTokens > 0) || !(spentBudget > 0) || limits.max <= limits.min) return null;
  const headroom = Math.max(Math.round(spentBudget / 4), 4096);
  const aligned = Math.ceil((fixedTokens + headroom) / 1024) * 1024;
  return Math.min(Math.max(aligned, limits.min), limits.max);
}

/**
 * 提升后的 num_ctx 是否真的解除了这道门。门的重算复用 contextManager 的
 * calculateSafetyMargin（与 enforceContextBudget 完全一致），门不过就说明窗口
 * 救不了（比如固定开销就超过了保护上限），调用方落到 failover。
 */
export function canWindowHoldFixedCost(
  windowSize: number,
  reserveForOutput: number,
  fixedTokens: number,
): boolean {
  const raw = windowSize - reserveForOutput;
  if (raw <= 0) return false;
  return fixedTokens <= raw - calculateSafetyMargin(raw, windowSize);
}

/** num_ctx 的保护上限：显存吃不起无限窗口；超出说明模型本身放不下，落到下一级。 */
export const OLLAMA_NUM_CTX_MIN = 8192;
export const OLLAMA_NUM_CTX_MAX = 65536;
