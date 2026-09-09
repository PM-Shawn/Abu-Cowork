/**
 * The installed-plugins list — 「我的」 when `mode="authored"`.
 *
 * 「我的」 means *authored by the user*, not merely "installed": a plugin
 * fetched from someone else's repo is somebody else's work and belongs in 市场
 * (shown in place there), never under a heading that reads as the user's own.
 * `isSelfAuthoredPlugin` is the single definition of that; see `authored.ts`.
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
import { isSelfAuthoredPlugin } from '@/core/plugin/authored';
import { InstalledPluginSummary } from './InstalledPluginDetail';
import ToolGrid from '@/components/toolbox/ToolGrid';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import UninstallPluginDialog from './UninstallPluginDialog';

interface InstalledPluginListProps {
  home: string;
  grouped?: boolean;
  searchQuery: string;
  /**
   * `'authored'` narrows the list to plugins the user wrote themselves (the
   * 「我的」 panel). `'all'` keeps the whole personal set — no surface ships it
   * today, but it is the difference this component's own tests pin, so the
   * authored filter cannot silently become the only behaviour there is.
   */
  mode?: 'authored' | 'all';
  /** Only offered in `'all'` mode — 「我的」 explains authoring instead. */
  onBrowseMarketplace?: () => void;
}

export default function InstalledPluginList({
  home,
  searchQuery,
  mode = 'all',
  grouped = false,
  onBrowseMarketplace,
}: InstalledPluginListProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const installed = usePluginStore((s) => s.installed);
  const [pendingRemoval, setPendingRemoval] = useState<InstalledPlugin | null>(null);

  // The personal view never lists organization-installed plugins — those
  // are managed (and uninstalled) from the 组织 view only, same as skills.
  // Both the list and the empty state key off this partition, so a user whose
  // installs are all organization-scoped sees the empty state, not "no matches".
  const scoped = useMemo(() => {
    const { personal } = partitionInstalled(installed);
    return mode === 'authored' ? personal.filter(isSelfAuthoredPlugin) : personal;
  }, [installed, mode]);

  const visible = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return scoped;
    return scoped.filter((p) => `${p.name} ${p.marketplace}`.toLowerCase().includes(query));
  }, [scoped, searchQuery]);

  if (grouped && visible.length === 0) return (
    <section className="px-8 pb-6" data-testid="plugin-mine-group">
      <div className="mx-auto max-w-5xl">
        <h3 className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.sourceMine}</h3>
        <div className="rounded-xl border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-5 text-minor text-[var(--abu-text-muted)]">
          {scoped.length === 0 ? tb.pluginsMineEmptyTitle : tb.pluginsNoMatches}
        </div>
      </div>
    </section>
  );

  if (scoped.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Package className="h-8 w-8 text-[var(--abu-text-placeholder)]" />
        {mode === 'authored' ? (
          <>
            <p className="text-h-sm text-[var(--abu-text-primary)]">{tb.pluginsMineEmptyTitle}</p>
            <p className="max-w-md text-body text-[var(--abu-text-tertiary)]">
              {tb.pluginsMineEmptyHint}
            </p>
          </>
        ) : (
          <>
            <p className="text-body text-[var(--abu-text-tertiary)]">{tb.pluginsEmptyState}</p>
            {onBrowseMarketplace && (
              <Button variant="outline" onClick={onBrowseMarketplace}>
                {tb.pluginsGoToMarketplace}
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={grouped ? "px-8 pb-6" : "h-full overflow-y-auto px-8 py-3"}><div className="max-w-5xl mx-auto">
      {grouped && <h3 className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.sourceMine}</h3>}
      {visible.length === 0 ? (
        <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">
          {tb.pluginsNoMatches}
        </p>
      ) : (
        <ToolGrid>
          {visible.map((plugin) => (
            <MarketplaceEntryRow
              key={plugin.key}
              testId="plugin-mine-row"
              name={plugin.name}
              description={<InstalledPluginSummary plugin={plugin} />}
              actions={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${tb.pluginsUninstall}: ${plugin.name}`}
                onClick={() => setPendingRemoval(plugin)}
              >
                <Trash2 className="h-3.5 w-3.5 text-[var(--abu-danger)]" />
                <span className="text-[var(--abu-danger)]">{tb.pluginsUninstall}</span>
              </Button>
              }
            />
          ))}
        </ToolGrid>
      )}

      </div>
      <UninstallPluginDialog
        home={home}
        target={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
      />
    </div>
  );
}
