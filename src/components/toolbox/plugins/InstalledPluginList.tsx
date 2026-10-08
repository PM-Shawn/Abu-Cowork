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
 * {@link useUninstallPlugin}, which owns the confirmation and the store call.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { usePluginStore } from '@/stores/pluginStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { partitionInstalled } from '@/core/plugin/enterpriseMarket';
import { isAuthoredInstall } from '@/core/plugin/authored';
import InstalledPluginDetail, { InstalledPluginSummary } from './InstalledPluginDetail';
import ToolGrid from '@/components/toolbox/ToolGrid';
import InstalledPluginCard from './InstalledPluginCard';
import { useUninstallPlugin } from './useUninstallPlugin';
import { cardIndex, cardOrNeighbour, cardProps, focusByTestId, focusIsOnWindow } from '../cardFocus';

/**
 * One card of the shelf. memo: a window opening over the shelf, or a card
 * leaving it, renders no other card again. Its callbacks are the same for the
 * life of the list.
 */
const MineCard = memo(function MineCard({ plugin, home, onOpen, onUninstall }: {
  plugin: InstalledPlugin;
  home: string;
  onOpen: (key: string) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
}) {
  const { t } = useI18n();
  const tb = t.toolbox;
  return (
    <InstalledPluginCard
      plugin={plugin}
      home={home}
      testId="plugin-mine-row"
      description={<InstalledPluginSummary plugin={plugin} />}
      onClick={() => onOpen(plugin.key)}
      actions={
        <Button
          variant="danger"
          size="sm"
          icon={AppIcons.delete}
          aria-label={`${tb.pluginsUninstall}: ${plugin.name}`}
          onClick={(event) => { event.stopPropagation(); onUninstall(plugin); }}
        >
          {tb.pluginsUninstall}
        </Button>
      }
    />
  );
});

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

  // The install the uninstall question is about, and where its card sits. When the question
  // ends the focus goes back to that card; once the card has gone, to the card that took its
  // place, else the one before it, else the shelf's own button, else the page's 「添加」.
  const rootRef = useRef<HTMLDivElement>(null);
  const leaving = useRef<{ key: string; index: number } | null>(null);
  const focusCardOrWhatReplacedIt = useCallback(() => {
    const root = rootRef.current;
    const gone = leaving.current;
    // Only when no control has the focus: the user may have moved on while the uninstall ran.
    if (!root || !gone || !focusIsOnWindow()) return;
    const next = cardOrNeighbour(root, 'plugin-mine', gone.key, gone.index) ?? root.querySelector<HTMLElement>('button');
    if (next) next.focus();
    else focusByTestId('plugin-create-trigger');
  }, []);
  const { ask } = useUninstallPlugin(home, focusCardOrWhatReplacedIt);
  const askToUninstall = useCallback((plugin: InstalledPlugin) => {
    leaving.current = { key: plugin.key, index: cardIndex(rootRef.current, 'plugin-mine', plugin.key) };
    ask(plugin);
  }, [ask]);
  useLayoutEffect(() => {
    const gone = leaving.current;
    if (!gone || installed.some((plugin) => plugin.key === gone.key)) return;
    focusCardOrWhatReplacedIt();
    leaving.current = null;
  }, [installed, focusCardOrWhatReplacedIt]);

  const emptyState = scoped.length === 0 ? (
    // Two ways to fill the shelf, so the empty state names both.
    <EmptyState
      icon={AppIcons.bundle}
      title={tb.pluginsEmptyState}
      description={tb.pluginsMineEmptyHint}
      action={onBrowseMarketplace && <Button variant="secondary" onClick={onBrowseMarketplace}>{tb.pluginsGoToMarketplace}</Button>}
    />
  ) : (
    <EmptyState icon={AppIcons.bundle} title={tb.pluginsNoMatches} />
  );

  // The grid is mounted even while empty: what the user created here reports
  // how many cards it has from inside it, so an unmounted child could never
  // say it has any.
  const body = <>
    {visible.length === 0 && childCount === 0 && emptyState}
    <ToolGrid>
      {visible.map((plugin) => (
        <div key={plugin.key} className="h-full" {...cardProps('plugin-mine', plugin.key)}>
          <MineCard plugin={plugin} home={home} onOpen={setSelectedKey} onUninstall={askToUninstall} />
        </div>
      ))}
      {children}
    </ToolGrid>
  </>;

  return (
    <div ref={rootRef} className="px-8 py-3" data-testid="plugin-mine-group">
      <div className="mx-auto max-w-5xl">
        {body}
      </div>
      <InstalledPluginDetail
        home={home}
        plugin={selected}
        onClose={() => setSelectedKey(null)}
        onUninstall={(plugin) => { setSelectedKey(null); askToUninstall(plugin); }}
      />
    </div>
  );
}
