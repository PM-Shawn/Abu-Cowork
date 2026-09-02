/**
 * The installed-plugins list.
 *
 * Counts come from the install record's `contributed` list — the same list the
 * uninstaller withdraws from — rather than from rescanning the package
 * directory. That keeps what the UI *says* a plugin brought in identical to
 * what removal actually takes back out, even if the package grew files after
 * the user approved its disclosure.
 *
 * Uninstall is destructive (it deletes the package directory and withdraws its
 * skills and MCP servers), so it goes through `ConfirmDialog` and the
 * confirmation names what disappears, not just the plugin.
 */

import { useMemo, useState } from 'react';
import { Package, Trash2 } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { partitionInstalled } from '@/core/plugin/enterpriseMarket';

interface InstalledPluginListProps {
  home: string;
  searchQuery: string;
  onBrowseMarketplace: () => void;
}

export default function InstalledPluginList({
  home,
  searchQuery,
  onBrowseMarketplace,
}: InstalledPluginListProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const installed = usePluginStore((s) => s.installed);
  const uninstall = usePluginStore((s) => s.uninstall);
  const addToast = useToastStore((s) => s.addToast);
  const [pendingRemoval, setPendingRemoval] = useState<InstalledPlugin | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const visible = useMemo(() => {
    // The personal view never lists organization-installed plugins — those
    // are managed (and uninstalled) from the 组织 view only, same as skills.
    const { personal } = partitionInstalled(installed);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return personal;
    return personal.filter((p) => `${p.name} ${p.marketplace}`.toLowerCase().includes(query));
  }, [installed, searchQuery]);

  const handleConfirmUninstall = async () => {
    const target = pendingRemoval;
    if (!target) return;
    setPendingRemoval(null);
    setBusyKey(target.key);
    try {
      await uninstall(home, target.key);
    } catch (err) {
      addToast({
        type: 'error',
        title: tb.pluginsUninstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  if (installed.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Package className="h-8 w-8 text-[var(--abu-text-placeholder)]" />
        <p className="text-body text-[var(--abu-text-tertiary)]">{tb.pluginsEmptyState}</p>
        <Button variant="outline" onClick={onBrowseMarketplace}>
          {tb.pluginsGoToMarketplace}
        </Button>
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
              data-testid="installed-plugin-row"
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
                <p className="mt-0.5 truncate text-minor text-[var(--abu-text-tertiary)]">
                  {format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
                  {' · '}
                  {format(tb.pluginsSkillCount, { count: plugin.contributed.skills.length })}
                  {' · '}
                  {format(tb.pluginsServerCount, { count: plugin.contributed.mcpServers.length })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busyKey === plugin.key}
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

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={tb.pluginsUninstallTitle}
        message={format(tb.pluginsUninstallMessage, {
          name: pendingRemoval?.name ?? '',
          skills: pendingRemoval?.contributed.skills.length ?? 0,
          servers: pendingRemoval?.contributed.mcpServers.length ?? 0,
        })}
        confirmText={tb.pluginsUninstall}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={() => void handleConfirmUninstall()}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}
