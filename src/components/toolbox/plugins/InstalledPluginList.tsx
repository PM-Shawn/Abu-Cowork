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
import UninstallPluginDialog from './UninstallPluginDialog';

interface InstalledPluginListProps {
  home: string;
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
    <div className="h-full overflow-y-auto px-8 py-3">
      {visible.length === 0 ? (
        <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">
          {tb.pluginsNoMatches}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((plugin) => (
            <li
              key={plugin.key}
              data-testid="plugin-mine-row"
              className="flex items-center gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-h-xs text-[var(--abu-text-primary)]">
                    {plugin.name}
                  </span>
                  <span className="shrink-0 text-caption text-[var(--abu-text-muted)]">
                    v{plugin.version}
                  </span>
                </div>
                <InstalledPluginSummary plugin={plugin} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${tb.pluginsUninstall}: ${plugin.name}`}
                onClick={() => setPendingRemoval(plugin)}
              >
                <Trash2 className="h-3.5 w-3.5 text-[var(--abu-danger)]" />
                <span className="text-[var(--abu-danger)]">{tb.pluginsUninstall}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <UninstallPluginDialog
        home={home}
        target={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
      />
    </div>
  );
}
