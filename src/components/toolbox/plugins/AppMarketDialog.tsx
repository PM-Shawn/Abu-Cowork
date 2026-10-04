/**
 * 应用市场 — what the switcher's 查看更多 opens (product spec §5.2).
 *
 * Apps are packaged the way plugins are, so the listing, the review screen
 * and the install all come from `MarketplaceBrowser`; `mode="apps"` is what
 * keeps the two apart, listing only entries that bring an app and leaving
 * market management to 扩展 → 插件.
 */

import { useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { Search } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { usePluginStore } from '@/stores/pluginStore';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { Input } from '@/components/ui/input';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import MarketplaceBrowser from './MarketplaceBrowser';

export default function AppMarketDialog() {
  const { t } = useI18n();
  const open = useAppStore((s) => s.appMarketOpen);
  const setOpen = useAppStore((s) => s.setAppMarketOpen);
  const onClose = () => setOpen(false);
  const [home, setHome] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);

  // The same bootstrap 扩展 → 插件 does on mount: the app market is often the
  // first market surface a user opens, and without it there is no market to
  // read (and no installed records to mark an app as already added).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    let cancelled = false;
    homeDir()
      .then(async (dir) => {
        if (cancelled) return;
        setHome(dir);
        await refreshInstalled(dir);
      })
      .catch((error) => console.error('[app-market] home directory unavailable', error));
    resolveBuiltinMarketDir()
      .then((marketDir) => {
        if (cancelled || !marketDir) return;
        ensureBuiltinMarketplace(marketDir);
      })
      .catch((error) => console.error('[app-market] built-in market unavailable', error));
    return () => { cancelled = true; };
  }, [open, refreshInstalled, ensureBuiltinMarketplace]);

  return (
    <ToolDetailModal
      open={open}
      onClose={onClose}
      ariaLabel={t.appMarket.title}
      testId="app-market-dialog"
      title={t.appMarket.title}
      subtitle={t.appMarket.subtitle}
      maxWidth="max-w-4xl"
      panelClassName="h-[70vh]"
      headerActions={
        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--abu-text-muted)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.appMarket.searchPlaceholder}
            aria-label={t.appMarket.searchPlaceholder}
            data-testid="app-market-search"
            className="h-8 pl-8"
          />
        </div>
      }
    >
      {home !== null && (
        <div className="-mx-6 h-full">
          <MarketplaceBrowser
            home={home}
            mode="apps"
            searchQuery={query}
            onAddMarketplace={onClose}
          />
        </div>
      )}
    </ToolDetailModal>
  );
}
