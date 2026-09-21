import { PackageX } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { ConversationAppBinding } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';

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
    <div data-testid="conversation-app-removed" className="mb-2 flex items-center gap-3 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-2.5">
      <PackageX className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
      <p className="min-w-0 flex-1 text-minor text-[var(--abu-text-secondary)]">{format(t.appHome.removedNotice, { name: binding.appName })}</p>
      <Button size="sm" variant="outline" onClick={() => setAppMarketOpen(true)}>{t.appHome.removedAction}</Button>
    </div>
  );
}
