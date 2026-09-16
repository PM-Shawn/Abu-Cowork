import type { ReactNode } from 'react';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { Toggle } from '@/components/ui/toggle';
import { useToastStore } from '@/stores/toastStore';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import { usePluginActivation } from './usePluginActivation';

/** Installed plugins share the skill card's click-to-open and inline toggle. */
export default function InstalledPluginCard({ plugin, home, description, onClick, actions, testId }: {
  plugin: InstalledPlugin;
  home: string;
  description?: ReactNode;
  onClick: () => void;
  actions?: ReactNode;
  testId: string;
}) {
  const activation = usePluginActivation(plugin, home);
  const addToast = useToastStore(s => s.addToast);
  return <MarketplaceEntryRow
    name={plugin.name}
    description={description}
    onClick={onClick}
    testId={testId}
    actions={<>{actions}<Toggle
      checked={activation.enabled}
      disabled={!activation.available || activation.busy}
      tone="green"
      size="sm"
      onChange={() => { void activation.toggle().catch(error => addToast({ type: 'error', title: plugin.name, message: String(error) })); }}
    /></>}
  />;
}
