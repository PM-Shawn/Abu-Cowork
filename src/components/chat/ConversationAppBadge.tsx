import type { ConversationAppBinding } from '@/types/app';
import AppLogo from '@/components/app/AppLogo';

/** The app a conversation was started in, as a title-bar pill next to the team badge. */
export default function ConversationAppBadge({ binding }: { binding: ConversationAppBinding }) {
  return (
    <span
      data-testid="chat-title-app-badge"
      className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--abu-bg-muted)] px-2 py-0.5 text-caption text-[var(--abu-text-tertiary)]"
      title={binding.appName}
    >
      <AppLogo name={binding.appName} logo={binding.appLogo} logoDark={binding.appLogoDark} size="sm" className="h-4 w-4 rounded" />
      <span className="truncate max-w-[160px]">{binding.appName}</span>
    </span>
  );
}
