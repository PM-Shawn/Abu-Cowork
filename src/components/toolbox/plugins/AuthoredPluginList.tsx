import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useI18n } from '@/i18n';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { cleanupPluginConfiguration, usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import type { PluginAuthor } from '@/core/plugin/authorBridge';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { pluginConfigFields, savePluginConfiguration } from '@/core/plugin/configuration';
import { releasePreparedInstall, type InstallDisclosure } from '@/core/plugin/installer';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Tag } from '@/components/ds/tag';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import InstalledItemMenu from '@/components/toolbox/InstalledItemMenu';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import InstalledPluginCard from './InstalledPluginCard';
import InstalledPluginDetail from './InstalledPluginDetail';
import InstallDisclosureDialog, { type InstallPlanState } from './InstallDisclosureDialog';
import UninstallPluginDialog from './UninstallPluginDialog';
import { PLUGIN_WINDOW_CONTENT_HEIGHT } from './windowHeight';
import { cardIndex, cardOrNeighbour, cardProps, focusByTestId, focusIsOnWindow } from '../cardFocus';

/** The card at `from`, or what took its place once it has gone, else the page's 「添加」 button. */
function focusMineCard(from: { id: string; index: number } | null) {
  if (!from) return;
  const card = cardOrNeighbour(document, 'plugin-mine', from.id, from.index);
  if (card) card.focus();
  else focusByTestId('plugin-create-trigger');
}

/**
 * What the user created here — drafts and the installs they produced — as
 * cards for the 「我的」 shelf's own grid: one list, whether a plugin arrived
 * from a market or was written here. The windows are design-system dialogs, so
 * they sit alongside the cards without becoming grid items.
 * `onVisibleCount` reports how many cards this render contributes, which is
 * what the shelf's empty state counts.
 */
export default function AuthoredPluginList({ home, searchQuery, onVisibleCount }: { home: string; searchQuery: string; onVisibleCount?: (count: number) => void }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const ask = useConfirm();
  const authors = usePluginAuthorStore(s => s.authors);
  const error = usePluginAuthorStore(s => s.error);
  const refresh = usePluginAuthorStore(s => s.refresh);
  const installed = usePluginStore(s => s.installed);
  const deletingRef = useRef(false);
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

  // The card whose windows are open, and where it sits. Its windows replace one another (detail,
  // preview, detail again), so the one that closes last may have opened from a control that is
  // gone: the focus then goes back to the card, or to what took its place once it has gone.
  const opener = useRef<{ id: string; index: number } | null>(null);
  const windowOpen = useRef(false);
  useLayoutEffect(() => { windowOpen.current = selected !== null || plan !== null || removing !== null; });
  const openDetail = (author: PluginAuthor) => {
    opener.current = { id: author.id, index: cardIndex(document, 'plugin-mine', author.id) };
    setSelected(author);
  };
  const afterWindowClosed = (event: Event) => {
    // Another layer took the focus, or one of this card's windows is still open.
    if (event.defaultPrevented || windowOpen.current || !opener.current) return;
    event.preventDefault();
    focusMineCard(opener.current);
  };
  // An uninstall turns the installed card back into its draft card: the focus that was on it has nowhere to be.
  const uninstalled = useRef(false);
  useLayoutEffect(() => {
    if (!uninstalled.current || windowOpen.current || !focusIsOnWindow()) return;
    uninstalled.current = false;
    focusMineCard(opener.current);
  }, [installed]);

  // Keys still reach a window that is fading out; nothing in it acts then.
  const selectedRef = useRef(selected);
  useLayoutEffect(() => { selectedRef.current = selected; });
  const stillOpen = (author: PluginAuthor) => selectedRef.current?.id === author.id;

  const edit = (author: PluginAuthor) => { void usePluginAuthorStore.getState().edit(author).catch(report); };
  const reveal = (author: PluginAuthor) => { void revealItemInDir(author.sourceDir).catch(report); };
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
      // A draft with `app` installs as 「安装并进入」: land on its home once the
      // app list has picked the new record up.
      if (disclosure.app && !installed) useAppStore.getState().enterAppWhenAvailable(disclosure.key);
    } catch (error) { setPlan({ author, state: { kind: 'error', message: String(error) } }); report(error); }
    finally {
      if (installingToken) await releasePreparedInstall(installingToken).catch(() => {});
      await cleanupPluginConfiguration(pluginConfiguration);
      installing.current = false; setBusy(false);
    }
  };
  // Deleting a draft forgets it for good, so it is asked first, with the directory that stays behind.
  // The question is asked over the draft's window and ends with it.
  const deleteDraft = async (author: PluginAuthor) => {
    const confirmed = await ask({ title: tb.pluginsDeleteDraft, message: `${tb.pluginsDeleteDraftWarning}\n${author.sourceDir}`, confirmLabel: tb.pluginsDeleteDraft, tone: 'danger' });
    if (!confirmed || deletingRef.current) return;
    // Read again at answer time: the draft may be gone, or installed by now (an installed one is uninstalled, not deleted).
    const current = usePluginAuthorStore.getState().authors.find(item => item.id === author.id);
    if (!current || usePluginStore.getState().installed.some(item => item.authoringId === current.id || item.key === current.key)) return;
    deletingRef.current = true;
    void usePluginAuthorStore.getState().remove(current.id).then(() => { setSelected(null); }).catch(report)
      .finally(() => { deletingRef.current = false; });
  };
  // Only a draft that was never installed can be deleted; an installed one is uninstalled.
  const isDraftOnly = (author: PluginAuthor) => !installed.some(item => item.authoringId === author.id || item.key === author.key);
  const hasUpdate = (author: PluginAuthor) => Boolean(author.prepared && recordFor(author) && author.prepared.checksum !== recordFor(author)?.checksum);
  const selectedRecord = selected ? recordFor(selected) : undefined;
  // A window stays on the page while it fades out and keeps showing the card it was opened for.
  const [held, setHeld] = useState(selected);
  if (selected && selected !== held) setHeld(selected);
  const shown = selected ?? held;
  // The draft window shows a card that has no install; the installed one has its own window.
  const draftOpen = selected !== null && !selectedRecord;
  const [heldDraft, setHeldDraft] = useState(draftOpen ? selected : null);
  if (draftOpen && selected !== heldDraft) setHeldDraft(selected);
  const draft = draftOpen ? selected : heldDraft;
  useEffect(() => { onVisibleCount?.(visible.length); }, [onVisibleCount, visible.length]);
  const cards = visible.map(author => {
    const record = recordFor(author);
    return <div key={author.id} className="h-full" {...cardProps('plugin-mine', author.id)}>
      {record ? <InstalledPluginCard plugin={record} home={home} description={author.prepared?.description} testId="plugin-mine-row" actions={hasUpdate(author) ? <Tag tone="info">{tb.pluginsAuthorUpdateAvailable}</Tag> : undefined} onClick={() => openDetail(author)} />
        : <MarketplaceEntryRow testId="plugin-mine-draft" name={author.name ?? tb.pluginsDraft}
          description={author.prepared?.description || tb.pluginsDraftHint} onClick={() => openDetail(author)}
          actions={<span className="text-ui-sm text-label-tertiary">{author.prepared ? tb.pluginsReadyToInstall : tb.pluginsDraft}</span>} />}
    </div>;
  });
  const dialogs = <>
    {draft && <ToolDetailModal open={draftOpen} testId="plugin-author-detail" ariaLabel={draft.name ?? tb.pluginsDraft} onClose={() => setSelected(null)} onCloseAutoFocus={afterWindowClosed} stackedHeader maxWidth="max-w-2xl" panelClassName={PLUGIN_WINDOW_CONTENT_HEIGHT} avatar={<Icon icon={AppIcons.bundle} size="lg" className="text-label-tertiary" />}
      headerActions={<InstalledItemMenu ariaLabel={tb.plugins} testId="plugin-author-menu" actions={[
        { id: 'edit', label: tb.pluginsContinueEditing, onSelect: () => { if (stillOpen(draft)) edit(draft); } },
        { id: 'source', label: tb.pluginsSourceFiles, onSelect: () => { if (stillOpen(draft)) reveal(draft); } },
        ...(isDraftOnly(draft) ? [{ id: 'delete' as const, label: tb.pluginsDeleteDraft, destructive: true, onSelect: () => { if (stillOpen(draft)) void deleteDraft(draft); } }] : []),
      ]} />}
      footer={<div className="flex w-full items-center justify-between gap-3"><Button variant="secondary" onClick={() => { if (stillOpen(draft)) edit(draft); }}>{tb.pluginsContinueEditing}</Button><Button variant="primary" onClick={() => { if (stillOpen(draft)) void prepare(draft); }}>{tb.pluginsReviewChanges}</Button></div>}>
      <h2 className="text-title text-label">{draft.name ?? tb.pluginsDraft} <span className="font-normal text-label-tertiary">{tb.plugins}</span></h2>
      <p className="mt-3 text-ui text-label-tertiary">{draft.prepared?.description || tb.pluginsDraftHint}</p>
    </ToolDetailModal>}
    <InstalledPluginDetail home={home} plugin={selectedRecord ?? null} description={shown?.prepared?.description} onClose={() => setSelected(null)} onCloseAutoFocus={afterWindowClosed}
      onUninstall={plugin => { setSelected(null); uninstalled.current = true; setRemoving(plugin); }}
      authorUpdate={shown ? { available: hasUpdate(shown), onReview: () => { if (stillOpen(shown)) void prepare(shown); } } : undefined}
      authorActions={shown ? [
        // The installed window runs these only while it is open.
        { id: 'edit', label: tb.pluginsContinueEditing, onSelect: () => edit(shown) },
        { id: 'source', label: tb.pluginsSourceFiles, onSelect: () => reveal(shown) },
        ...(isDraftOnly(shown) ? [{ id: 'delete' as const, label: tb.pluginsDeleteDraft, destructive: true, onSelect: () => { void deleteDraft(shown); } }] : []),
      ] : undefined} />
    <InstallDisclosureDialog authoring updating={Boolean(plan && recordFor(plan.author))} open={plan !== null} entryName={plan?.author.name ?? tb.pluginsDraft} state={plan?.state ?? { kind: 'loading' }} installing={busy}
      onCloseAutoFocus={afterWindowClosed}
      onCancel={cancel} onConfirm={configuration => { if (plan?.state.kind === 'ready') void confirm(plan.author, plan.state.disclosure, configuration); }} />
    <UninstallPluginDialog home={home} target={removing} onClose={() => { setRemoving(null); if (focusIsOnWindow()) focusMineCard(opener.current); }} />
  </>;
  return <>
    {error && <div className="col-span-full"><InlineMessage tone="danger">{error}</InlineMessage></div>}
    {cards}{dialogs}
  </>;
}
