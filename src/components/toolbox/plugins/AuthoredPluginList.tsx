import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Package } from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n } from '@/i18n';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { cleanupPluginConfiguration, usePluginStore } from '@/stores/pluginStore';
import { useToastStore } from '@/stores/toastStore';
import type { PluginAuthor } from '@/core/plugin/authorBridge';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { pluginConfigFields, savePluginConfiguration } from '@/core/plugin/configuration';
import { releasePreparedInstall, type InstallDisclosure } from '@/core/plugin/installer';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import ToolGrid from '@/components/toolbox/ToolGrid';
import InstalledItemMenu, { type InstalledItemMenuAction } from '@/components/toolbox/InstalledItemMenu';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import InstalledPluginCard from './InstalledPluginCard';
import InstalledPluginDetail from './InstalledPluginDetail';
import InstallDisclosureDialog, { type InstallPlanState } from './InstallDisclosureDialog';
import UninstallPluginDialog from './UninstallPluginDialog';

export default function AuthoredPluginList({ home, searchQuery }: { home: string; searchQuery: string }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const authors = usePluginAuthorStore(s => s.authors);
  const error = usePluginAuthorStore(s => s.error);
  const refresh = usePluginAuthorStore(s => s.refresh);
  const installed = usePluginStore(s => s.installed);
  const [deleting, setDeleting] = useState<PluginAuthor | null>(null);
  const deletingRef = useRef(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [selected, setSelected] = useState<PluginAuthor | null>(null);
  const [removing, setRemoving] = useState<InstalledPlugin | null>(null);
  const [plan, setPlan] = useState<{ author: PluginAuthor; state: InstallPlanState } | null>(null);
  const epoch = useRef(0);
  const installing = useRef(false);
  const token = useRef<string | undefined>(undefined);
  useEffect(() => () => { epoch.current++; if (token.current) void releasePreparedInstall(token.current).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false);
  const toast = useToastStore(s => s.addToast);
  const report = (error: unknown) => toast({ type: 'error', title: tb.plugins, message: String(error) });
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  const recordFor = (author: PluginAuthor) => installed.find(item => item.key === author.key && item.authoringId === author.id);
  const visible = authors.filter(author => `${author.name ?? tb.pluginsDraft} ${author.prepared?.description ?? ''}`.toLowerCase().includes(searchQuery.trim().toLowerCase()));
  const edit = (author: PluginAuthor) => { void usePluginAuthorStore.getState().edit(author).catch(report); };
  const prepare = async (author: PluginAuthor) => {
    const requestEpoch = ++epoch.current;
    setSelected(null); setPlan({ author, state: { kind: 'loading' } });
    try {
      const prepared = await usePluginAuthorStore.getState().prepare({ id: author.id });
      if (requestEpoch !== epoch.current) {
        if (prepared.disclosure.preparedToken) await releasePreparedInstall(prepared.disclosure.preparedToken);
        return;
      }
      const previous = recordFor(prepared.author);
      if (previous && prepared.author.prepared && previous.checksum === prepared.author.prepared.checksum) {
        if (prepared.disclosure.preparedToken) await releasePreparedInstall(prepared.disclosure.preparedToken);
        setPlan({ author: prepared.author, state: { kind: 'unchanged' } });
        return;
      }
      token.current = prepared.disclosure.preparedToken;
      setPlan({ author: prepared.author, state: { kind: 'ready', disclosure: prepared.disclosure } });
    } catch (error) { if (requestEpoch === epoch.current) setPlan({ author, state: { kind: 'error', message: String(error) } }); }
  };
  const cancel = () => {
    if (installing.current) return;
    epoch.current++;
    token.current = undefined;
    if (plan?.state.kind === 'ready' && plan.state.disclosure.preparedToken) void releasePreparedInstall(plan.state.disclosure.preparedToken).catch(report);
    if (plan) setSelected(plan.author);
    setPlan(null);
  };
  const confirm = async (author: PluginAuthor, disclosure: InstallDisclosure, configuration: Record<string, string>) => {
    if (installing.current) return;
    installing.current = true;
    const installingToken = disclosure.preparedToken;
    token.current = undefined;
    setBusy(true);
    let pluginConfiguration: string | undefined;
    try {
      pluginConfiguration = await savePluginConfiguration(disclosure.key, pluginConfigFields(disclosure.manifest.mcpServers), configuration);
      const request = { home, pluginConfiguration, enableMcp: true, marketplaceName: author.marketplace, marketplaceDir: author.sourceDir,
        entry: { name: disclosure.name, source: { kind: 'relative' as const, path: '.' } }, preparedToken: disclosure.preparedToken };
      const installed = recordFor(author);
      if (installed) await usePluginStore.getState().update({ ...request, key: installed.key });
      else await usePluginStore.getState().install(request);
      setPlan(null); setSelected(author);
    } catch (error) { setPlan({ author, state: { kind: 'error', message: String(error) } }); report(error); }
    finally {
      if (installingToken) await releasePreparedInstall(installingToken).catch(() => {});
      await cleanupPluginConfiguration(pluginConfiguration);
      installing.current = false; setBusy(false);
    }
  };
  const sourceActions = (author: PluginAuthor): InstalledItemMenuAction[] => [
    { id: 'edit', label: tb.pluginsContinueEditing, onSelect: () => edit(author) },
    ...(!installed.some(item => item.authoringId === author.id || item.key === author.key) ? [{ id: 'delete' as const, label: tb.pluginsDeleteDraft, destructive: true, onSelect: () => setDeleting(author) }] : []),
    { id: 'source', label: tb.pluginsSourceFiles, onSelect: () => { void revealItemInDir(author.sourceDir).catch(report); } },
  ];
  const hasUpdate = (author: PluginAuthor) => Boolean(author.prepared && recordFor(author) && author.prepared.checksum !== recordFor(author)?.checksum);
  const selectedRecord = selected ? recordFor(selected) : undefined;
  return <section className="px-8 pb-6" data-testid="plugin-mine-group"><div className="mx-auto max-w-5xl">
    <h3 className="mb-3 pl-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.sourceMine}</h3>
    {error && <p role="alert" className="mb-3 text-minor text-[var(--abu-danger)]">{error}</p>}
    {visible.length === 0 ? <div className="rounded-xl border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-4 py-5 text-minor text-[var(--abu-text-muted)]">{authors.length ? tb.pluginsNoMatches : tb.pluginsMineEmptyTitle}</div> : <ToolGrid>
      {visible.map(author => {
        const record = recordFor(author);
        return record ? <InstalledPluginCard key={author.id} plugin={record} home={home} description={author.prepared?.description} testId="plugin-mine-row" actions={hasUpdate(author) ? <span className="text-minor text-[var(--abu-clay)]">{tb.pluginsAuthorUpdateAvailable}</span> : undefined} onClick={() => setSelected(author)} />
          : <MarketplaceEntryRow key={author.id} testId="plugin-mine-draft" name={author.name ?? tb.pluginsDraft}
            description={author.prepared?.description || tb.pluginsDraftHint} onClick={() => setSelected(author)}
            actions={<span className="text-minor text-[var(--abu-text-muted)]">{author.prepared ? tb.pluginsReadyToInstall : tb.pluginsDraft}</span>} />;
      })}
    </ToolGrid>}
    {selected && !selectedRecord && createPortal(<ToolDetailModal open testId="plugin-author-detail" ariaLabel={selected.name ?? tb.pluginsDraft} onClose={() => setSelected(null)} stackedHeader maxWidth="max-w-2xl" panelClassName="h-[min(640px,85vh)]" avatar={<Package className="h-6 w-6" />}
      headerActions={<InstalledItemMenu ariaLabel={tb.plugins} testId="plugin-author-menu" actions={sourceActions(selected)} />}
      footer={<div className="flex justify-between gap-3"><Button variant="ghost" onClick={() => edit(selected)}>{tb.pluginsContinueEditing}</Button><Button onClick={() => void prepare(selected)}>{tb.pluginsReviewChanges}</Button></div>}>
      <h2 className="text-h-lg font-semibold">{selected.name ?? tb.pluginsDraft} <span className="font-normal text-[var(--abu-text-muted)]">{tb.plugins}</span></h2>
      <p className="mt-3 text-body text-[var(--abu-text-muted)]">{selected.prepared?.description || tb.pluginsDraftHint}</p>
    </ToolDetailModal>, document.body)}
    <InstalledPluginDetail home={home} plugin={selectedRecord ?? null} description={selected?.prepared?.description} onClose={() => setSelected(null)} onUninstall={plugin => { setSelected(null); setRemoving(plugin); }}
      authorUpdate={selected ? { available: hasUpdate(selected), onReview: () => void prepare(selected) } : undefined}
      authorActions={selected ? sourceActions(selected) : undefined} />
    <InstallDisclosureDialog authoring updating={Boolean(plan && recordFor(plan.author))} open={plan !== null} entryName={plan?.author.name ?? tb.pluginsDraft} state={plan?.state ?? { kind: 'loading' }} installing={busy}
      onCancel={cancel} onConfirm={configuration => { if (plan?.state.kind === 'ready') void confirm(plan.author, plan.state.disclosure, configuration); }} />
    <ConfirmDialog open={deleting !== null} title={tb.pluginsDeleteDraft} message={<><p>{tb.pluginsDeleteDraftWarning}</p><p className="mt-2 break-all">{deleting?.sourceDir}</p></>}
      confirmText={tb.pluginsDeleteDraft} cancelText={t.common.cancel} variant="danger" confirmDisabled={deleteBusy}
      onCancel={() => { if (!deletingRef.current) setDeleting(null); }} onConfirm={() => {
        if (!deleting || deletingRef.current) return;
        deletingRef.current = true; setDeleteBusy(true);
        void usePluginAuthorStore.getState().remove(deleting.id).then(() => { setDeleting(null); setSelected(null); }).catch(report)
          .finally(() => { deletingRef.current = false; setDeleteBusy(false); });
      }} />
    <UninstallPluginDialog home={home} target={removing} onClose={() => setRemoving(null)} />
  </div></section>;
}
