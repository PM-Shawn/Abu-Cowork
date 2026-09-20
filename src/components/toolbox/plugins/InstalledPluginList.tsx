/**
 * The 「已安装」 group of the plugins 「我的」 shelf: every personal install the
 * user made from a marketplace. 「我的」 is what the user HAS — a plugin fetched
 * from someone else's market is theirs once installed, so it lists here (and
 * stays in the market with an 「已安装」 mark, where updates are offered).
 *
 * Two kinds of install are not this group's: organization installs (managed
 * and uninstalled from the 组织 view only, same as skills) and the user's own
 * creations (`isAuthoredInstall`), which `AuthoredPluginList` shows with
 * their drafts.
 *
 * Counts come from the install record's `contributed` list — the same list the
 * uninstaller withdraws from — rather than from rescanning the package
 * directory. That keeps what the UI *says* a plugin brought in identical to
 * what removal actually takes back out, even if the package grew files after
 * the user approved its disclosure.
 *
 * Uninstall is destructive, so it goes through the shared
 * {@link UninstallPluginDialog}, which owns the confirmation and the store call.
 */

import { useMemo, useState } from 'react';
import { Package, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { usePluginStore } from '@/stores/pluginStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { partitionInstalled } from '@/core/plugin/enterpriseMarket';
import { isAuthoredInstall } from '@/core/plugin/authored';
import InstalledPluginDetail, { InstalledPluginSummary } from './InstalledPluginDetail';
import ToolGrid from '@/components/toolbox/ToolGrid';
import InstalledPluginCard from './InstalledPluginCard';
import UninstallPluginDialog from './UninstallPluginDialog';

interface InstalledPluginListProps {
  home: string;
  /** Render as a titled group inside the 「我的」 shelf rather than as a whole panel. */
  grouped?: boolean;
  searchQuery: string;
  /** Offered from the empty state: the marketplace is where an install comes from. */
  onBrowseMarketplace?: () => void;
}

export default function InstalledPluginList({
  home,
  searchQuery,
  grouped = false,
  onBrowseMarketplace,
}: InstalledPluginListProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const installed = usePluginStore((s) => s.installed);
  const [pendingRemoval, setPendingRemoval] = useState<InstalledPlugin | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Both the list and the empty state key off this partition, so a user whose
  // installs are all organization-scoped or self-authored sees the empty
  // state, not "no matches".
  const scoped = useMemo(() => partitionInstalled(installed).personal.filter((p) => !isAuthoredInstall(p)), [installed]);

  const visible = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return scoped;
    return scoped.filter((p) => `${p.name} ${p.marketplace}`.toLowerCase().includes(query));
  }, [scoped, searchQuery]);

  const selected = scoped.find((p) => p.key === selectedKey) ?? null;

  const emptyState = (
    <div className={grouped
      ? 'flex flex-col items-start gap-2 rounded-xl border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-5 text-minor text-[var(--abu-text-muted)]'
      : 'flex h-full flex-col items-center justify-center gap-3 px-8 text-center'}>
      {!grouped && <Package className="h-8 w-8 text-[var(--abu-text-placeholder)]" />}
      <p className={grouped ? undefined : 'text-body text-[var(--abu-text-tertiary)]'}>{scoped.length === 0 ? tb.pluginsEmptyState : tb.pluginsNoMatches}</p>
      {scoped.length === 0 && onBrowseMarketplace && (
        <Button variant="outline" size={grouped ? 'sm' : 'default'} onClick={onBrowseMarketplace}>
          {tb.pluginsGoToMarketplace}
        </Button>
      )}
    </div>
  );

  const body = visible.length === 0 ? emptyState : (
    <ToolGrid>
      {visible.map((plugin) => (
        <InstalledPluginCard
          key={plugin.key}
          plugin={plugin}
          home={home}
          testId="plugin-mine-row"
          description={<InstalledPluginSummary plugin={plugin} />}
          onClick={() => setSelectedKey(plugin.key)}
          actions={
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${tb.pluginsUninstall}: ${plugin.name}`}
              onClick={(event) => { event.stopPropagation(); setPendingRemoval(plugin); }}
            >
              <Trash2 className="h-3.5 w-3.5 text-[var(--abu-danger)]" />
              <span className="text-[var(--abu-danger)]">{tb.pluginsUninstall}</span>
            </Button>
          }
        />
      ))}
    </ToolGrid>
  );

  return (
    <div className={grouped ? 'px-8 pb-6' : 'h-full overflow-y-auto px-8 py-3'} data-testid={grouped ? 'plugin-installed-group' : undefined}>
      <div className="mx-auto max-w-5xl">
        {grouped && <h3 className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.pluginsInstalledGroup}</h3>}
        {body}
      </div>
      <InstalledPluginDetail
        home={home}
        plugin={selected}
        onClose={() => setSelectedKey(null)}
        onUninstall={(plugin) => { setSelectedKey(null); setPendingRemoval(plugin); }}
      />
      <UninstallPluginDialog
        home={home}
        target={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
      />
    </div>
  );
}
