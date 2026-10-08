import { PackageX } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { ConversationAppBinding } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { Button } from '@/components/ui/button';

/**
 * Shown above the composer when a conversation's app is no longer available
 * (product spec §5.9). The history stays readable; what the notice says
 * depends on where the app came from:
 *   - an organization app: disabled by the organization, or out of reach
 *     while offline (it comes back with the connection);
 *   - an app from a market or a folder: removed, and adding it again is the
 *     way back (「去添加」);
 *   - an app the user made: removed, and nothing can add it back.
 */
export default function ConversationAppNotice({ binding }: { binding: ConversationAppBinding }) {
  const { t, format } = useI18n();
  const present = useAppStore((s) => s.addedApps.some((app) => app.appId === binding.appId)
    || Object.values(s.managedApps).some((apps) => apps.some((app) => app.appId === binding.appId)));
  const offline = useEnterpriseStore((s) => s.mode.kind === 'offline');
  const setAppMarketOpen = useAppStore((s) => s.setAppMarketOpen);
  if (present) return null;
  const origin = binding.version === 2 ? binding.origin : 'market';
  const message = origin === 'enterprise'
    ? (offline ? t.appHome.offlineNotice : t.appHome.disabledNotice)
    : format(origin === 'created' ? t.appHome.removedCreatedNotice : t.appHome.removedNotice, { name: binding.appName });
  const canAddBack = origin === 'market' || origin === 'folder';
  return (
    <div data-testid="conversation-app-removed" data-origin={origin} className="mb-2 flex items-center gap-3 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-2.5">
      <PackageX className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
      <p className="min-w-0 flex-1 text-minor text-[var(--abu-text-secondary)]">{message}</p>
      {canAddBack && <Button size="sm" variant="outline" onClick={() => setAppMarketOpen(true)}>{t.appHome.removedAction}</Button>}
    </div>
  );
}
