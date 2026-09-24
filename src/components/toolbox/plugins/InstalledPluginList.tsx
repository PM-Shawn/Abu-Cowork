/**
 * The plugins 「我的」 shelf: every personal install the user made from a
 * marketplace. 「我的」 is what the user HAS — a plugin fetched from someone
 * else's market is theirs once installed, so it lists here (and stays in the
 * market with an 「已安装」 mark, where updates are offered).
 *
 * The shelf is one list. What the user created here comes through `children`
 * as more cards in the same grid (`AuthoredPluginList` in `bare` mode), so
 * where a plugin came from changes its detail panel, never its shelf.
 * Organization installs are the one kind kept out: they are managed and
 * uninstalled from the 组织 view only, same as skills.
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

import { useMemo, useState, type ReactNode } from 'react';
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
  searchQuery: string;
  /** Offered from the empty state: the marketplace is where an install comes from. */
  onBrowseMarketplace?: () => void;
  /** More cards for the same grid — what the user created here. */
  children?: ReactNode;
  /** How many of those there are, so the empty state counts the whole shelf. */
  childCount?: number;
}

export default function InstalledPluginList({
  home,
  searchQuery,
  onBrowseMarketplace,
  children,
  childCount = 0,
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
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <Package className="h-8 w-8 text-[var(--abu-text-placeholder)]" />
      <p className="text-body text-[var(--abu-text-tertiary)]">{scoped.length === 0 ? tb.pluginsEmptyState : tb.pluginsNoMatches}</p>
      {/* Two ways to fill the shelf, so the empty state names both. */}
      {scoped.length === 0 && <p className="text-caption text-[var(--abu-text-tertiary)]">{tb.pluginsMineEmptyHint}</p>}
      {scoped.length === 0 && onBrowseMarketplace && (
        <Button variant="outline" onClick={onBrowseMarketplace}>
          {tb.pluginsGoToMarketplace}
        </Button>
      )}
    </div>
  );

  // The grid is mounted even while empty: what the user created here reports
  // how many cards it has from inside it, so an unmounted child could never
  // say it has any.
  const body = <>
    {visible.length === 0 && childCount === 0 && emptyState}
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
      {children}
    </ToolGrid>
  </>;

  return (
    <div className="px-8 py-3" data-testid="plugin-mine-group">
      <div className="mx-auto max-w-5xl">
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
