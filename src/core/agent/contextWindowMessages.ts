import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { LocalServerKind } from '../llm/localProvider';

const SERVICE_NAMES: Record<LocalServerKind, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  'custom-local': 'LM Studio / Ollama',
};

/** Explain when fixed instructions and tools exceed the model's context window. */
export function contextTooSmallMessage(chat: TranslationDict['chat'], kind: LocalServerKind | null): string {
  return kind === null
    ? chat.contextFixedTooLarge
    : format(chat.contextFixedTooLargeLocal, { service: SERVICE_NAMES[kind] });
}

/** Include the required token count and the model's available context window. */
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

/** Format context lengths compactly: 8192 → 8K, 131072 → 128K, 1048576 → 1M. */
export function formatTokenCount(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  if (tokens % 1024 === 0) return `${(tokens / 1024).toFixed(0)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Select a window whose complete input budget includes room for conversation. */
export function planOllamaNumCtx(
  fixedTokens: number,
  spentBudget: number,
  limits: { min: number; max: number },
  inputBudgetForWindow: (windowSize: number) => number,
): number | null {
  if (![fixedTokens, spentBudget, limits.min, limits.max].every(Number.isFinite)
    || fixedTokens <= 0 || spentBudget <= 0 || limits.min <= 0 || limits.max < limits.min) return null;
  const headroom = Math.max(Math.round(spentBudget / 4), 4096);
  for (let candidate = Math.ceil(limits.min / 1024) * 1024; candidate <= limits.max; candidate += 1024) {
    const budget = inputBudgetForWindow(candidate);
    if (Number.isFinite(budget) && budget >= fixedTokens + headroom) return candidate;
  }
  return null;
}

/** Automatic local context expansion remains bounded. */
export const OLLAMA_NUM_CTX_MIN = 8192;
export const OLLAMA_NUM_CTX_MAX = 65536;
