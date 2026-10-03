import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { LocalServerKind } from '../llm/localProvider';

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
