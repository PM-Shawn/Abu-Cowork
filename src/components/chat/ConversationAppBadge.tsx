import { Tag } from '@/components/ds/tag';
import type { ConversationAppBinding } from '@/types/app';
import AppLogo from '@/components/app/AppLogo';

/** The app a conversation was started in, as a title-bar pill next to the team badge. */
export default function ConversationAppBadge({ binding }: { binding: ConversationAppBinding }) {
  return (
    <span data-testid="chat-title-app-badge" className="ml-2 inline-flex min-w-0 shrink-0" title={binding.appName}>
      <Tag>
        <AppLogo name={binding.appName} logo={binding.appLogo} logoDark={binding.appLogoDark} size="sm" className="h-4 w-4 rounded-control" />
        <span className="max-w-40 truncate">{binding.appName}</span>
      </Tag>
    </span>
  );
}
