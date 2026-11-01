import type { TranslationDict } from '@/i18n/types';

export function updateErrorMessage(error: string, messages: TranslationDict['updates']): string {
  if (error.includes('ABU_EXIT_CHILD_TIMEOUT')) return messages.exitTimeout;
  if (error.includes('ABU_UPDATE_PREPARATION_TIMEOUT')) return messages.preparationTimeout;
  if (error.includes('Application exit was cancelled')) return messages.restartCancelled;
  if (error.includes('Application restart did not complete')) return messages.restartTimeout;
  return error;
}
