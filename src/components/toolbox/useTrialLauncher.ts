import { useCallback } from 'react';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Longest hint (in CODE POINTS) we paste into the composer before eliding. */
const HINT_MAX = 80;

/**
 * 「立即试用」 — open a fresh conversation prefilled with a prompt that names the
 * item and quotes its description, then get the Extensions view out of the way.
 *
 * Order matters: the composer draft is set AFTER the new conversation exists,
 * matching ToolboxModal's AI-create entry.
 */
export function useTrialLauncher(): (item: { name: string; description?: string | null }) => void {
  const { t } = useI18n();
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeExtensions = useSettingsStore((s) => s.closeExtensions);

  return useCallback((item: { name: string; description?: string | null }) => {
    const raw = (item.description ?? '').replace(/\s+/g, ' ').trim();
    // Array.from so an emoji or other astral character counts as one, not two.
    const chars = Array.from(raw);
    const hint = chars.length === 0
      ? t.toolbox.trialPromptFallback
      : chars.length > HINT_MAX
        ? `${chars.slice(0, HINT_MAX).join('')}…`
        : raw;
    startNewConversation();
    setPendingInput(format(t.toolbox.trialPrompt, { name: item.name, hint }));
    closeExtensions();
  }, [t, startNewConversation, setPendingInput, closeExtensions]);
}
