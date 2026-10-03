import type { ReactNode } from 'react';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import { usePluginActivation } from './usePluginActivation';

/**
 * Installed plugins share the skill card's click-to-open and inline toggle.
 *
 * `control` says what the card's trailing control is. `toggle` is 「我的」,
 * where the user looks after what they have. `installed` is a plugin market,
 * which says whether the user already has this one, the same rule skills
 * follow. `none` is the app market: an app is entered or used, and an app was
 * never something the user thinks of as installed.
 */
export default function InstalledPluginCard({ plugin, home, description, onClick, actions, testId, control = 'toggle', name }: {
  plugin: InstalledPlugin;
  home: string;
  description?: ReactNode;
  onClick: () => void;
  actions?: ReactNode;
  testId: string;
  control?: 'toggle' | 'installed' | 'none';
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
    actions={<>{actions}
      {control === 'installed' && <span data-testid="plugin-installed-badge" className="flex"><Tag>{t.toolbox.installedMark}</Tag></span>}
      {/* The switch sits on a card that opens on click: its own click stays with it. While it is
          turning the plugin on it is busy: dimmed, no second press, the keyboard focus stays on it. */}
      {control === 'toggle' && <span className="flex" onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={activation.enabled}
          disabled={!activation.available}
          busy={activation.busy}
          aria-label={name ?? plugin.name}
          onCheckedChange={() => { void activation.toggle().catch(error => addToast({ type: 'error', title: plugin.name, message: String(error) })); }}
        />
      </span>}</>}
  />;
}
