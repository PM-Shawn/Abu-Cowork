import type { ReactNode } from 'react';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { Toggle } from '@/components/ui/toggle';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import { usePluginActivation } from './usePluginActivation';

/**
 * Installed plugins share the skill card's click-to-open and inline toggle.
 *
 * `market` marks the card as a market shelf's, where the same rule as skills
 * holds: the market says whether the user already has this one, and turning it
 * on and off belongs to 我的, where the user looks after what they have.
 */
export default function InstalledPluginCard({ plugin, home, description, onClick, actions, testId, market = false, name }: {
  plugin: InstalledPlugin;
  home: string;
  description?: ReactNode;
  onClick: () => void;
  actions?: ReactNode;
  testId: string;
  market?: boolean;
  /** Overrides the package name — an app card carries the app's own name. */
  name?: string;
}) {
  const { t } = useI18n();
  const activation = usePluginActivation(plugin, home);
  const addToast = useToastStore(s => s.addToast);
  return <MarketplaceEntryRow
    name={name ?? plugin.name}
    description={description}
    onClick={onClick}
    testId={testId}
    actions={<>{actions}{market
      ? <span data-testid="plugin-installed-badge" className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.installedMark}</span>
      : <Toggle
        checked={activation.enabled}
        disabled={!activation.available || activation.busy}
        tone="green"
        size="sm"
        onChange={() => { void activation.toggle().catch(error => addToast({ type: 'error', title: plugin.name, message: String(error) })); }}
      />}</>}
  />;
}
