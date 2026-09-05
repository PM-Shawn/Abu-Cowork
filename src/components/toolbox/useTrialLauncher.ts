import { useCallback } from 'react';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Longest hint (in CODE POINTS) we paste into the composer before eliding. */
const HINT_MAX = 80;

/** Longest name we paste. A marketplace entry's name is only checked non-empty
 *  at parse time and a rename target is displayed unvalidated, so the name is
 *  as untrusted as the description — left raw, a 10k-character name would push
 *  the actual instruction out of the composer. */
const NAME_MAX = 60;

/** Collapse whitespace runs, then cut to `max` CODE POINTS (Array.from so an
 *  emoji or other astral character counts as one, not two). */
function clamp(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : collapsed;
}

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
    const description = clamp(item.description ?? '', HINT_MAX);
    const hint = description === '' ? t.toolbox.trialPromptFallback : description;
    startNewConversation();
    setPendingInput(format(t.toolbox.trialPrompt, {
      name: clamp(item.name, NAME_MAX),
      hint,
    }));
    closeExtensions();
  }, [t, startNewConversation, setPendingInput, closeExtensions]);
}
