import { Minimize2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { Message } from '@/types';

export default function CompactDivider({ message }: { message: Message }) {
  const { t } = useI18n();
  const source = message.compactBoundary?.source;
  const label =
    source === 'manual'
      ? t.chat.compactDivider.compactedManual
      : t.chat.compactDivider.compacted;

  return (
    <div className="flex items-center gap-2 my-3 px-2 text-[var(--abu-text-tertiary)]">
      <div className="flex-1 h-px bg-[var(--abu-border)]" />
      <Minimize2 className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="text-xs select-none">{label}</span>
      <div className="flex-1 h-px bg-[var(--abu-border)]" />
    </div>
  );
}
