import { Button } from '@/components/ds/button';
import { InlineMessage } from '@/components/ds/inline-message';
import { useI18n } from '@/i18n';
import type { ConversationAppBinding } from '@/types/app';
import { useAppStore } from '@/stores/appStore';

/**
 * Shown above the composer when a conversation's app is no longer installed
 * or enabled (product spec §5.9): the history stays readable, and the way back
 * is to add the app again from the market.
 */
export default function ConversationAppNotice({ binding }: { binding: ConversationAppBinding }) {
  const { t, format } = useI18n();
  const present = useAppStore((s) => s.installedApps.some((app) => app.appId === binding.appId));
  const setAppMarketOpen = useAppStore((s) => s.setAppMarketOpen);
  if (present) return null;
  return (
    <div data-testid="conversation-app-removed" className="mb-2">
      <InlineMessage
        tone="info"
        action={<Button variant="secondary" size="sm" onClick={() => setAppMarketOpen(true)}>{t.appHome.removedAction}</Button>}
      >
        {format(t.appHome.removedNotice, { name: binding.appName })}
      </InlineMessage>
    </div>
  );
}
