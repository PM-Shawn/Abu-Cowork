import { useI18n } from '@/i18n';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import type { Message } from '@/types';

/**
 * Passive inline divider rendered for a compact-boundary marker message.
 *
 * A compact-boundary marker (role='system', isSystem NOT set) stays visible in
 * the message list but is not a real conversational turn — it just marks where
 * the older history was summarized away. Old messages stay above it unchanged
 * (no fold, no hide, no expand button); this is purely a visual separator,
 * mirroring WorkBuddy's compactDivider / Codex's synthetic divider.
 */
export default function CompactDivider({ message }: { message: Message }) {
  const { t } = useI18n();
  const source = message.compactBoundary?.source;
  const label =
    source === 'manual'
      ? t.chat.compactDivider.compactedManual
      : t.chat.compactDivider.compacted;

  return (
    <div className="my-3 flex items-center gap-2 px-2 text-label-tertiary">
      <div className="h-px flex-1 bg-separator" />
      <Icon icon={AppIcons.compact} size="sm" />
      <span className="select-none text-ui-sm">{label}</span>
      <div className="h-px flex-1 bg-separator" />
    </div>
  );
}
