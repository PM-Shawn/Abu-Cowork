import { useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { getI18n, format } from '@/i18n';
import { invokeElectronConversationBranch } from '@/utils/electronHost';
import { settingsForConversation } from '@/core/agent/conversationSettings';
import { findToolResultImageSnapshot, refreshOutputManifest } from './outputSnapshots';
import { conversationBranchPrefix, type BranchIdentity, type BranchResult } from './conversationBranchProtocol';
import { buildMeta, catalogReindexConversation, flushAndGetLedgerWatermark, flushIndex, promoteStreamSnapshots, updateIndexEntry } from './conversationStorage';
import type { ConversationMeta } from './conversationWriter';

interface Operation {
  identity: BranchIdentity;
  running?: Promise<string>;
  completed: boolean;
}
const operations = new Map<string, Operation>();
const recoveries = new Map<string, { committed?: Extract<BranchResult, { state: 'committed' | 'published' }>; running: boolean }>();
const listeners = new Set<() => void>();
const keyOf = (sourceId: string, messageId: string) => JSON.stringify([sourceId, messageId]);
function changed() { for (const listener of listeners) listener(); }
export function subscribeConversationBranches(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function isConversationBranchCreating(sourceId: string, messageId: string): boolean {
  return !!operations.get(keyOf(sourceId, messageId))?.running;
}
function settingsProof(sourceId: string): string {
  const source = useChatStore.getState().conversations[sourceId];
  if (!source || useChatStore.getState().loadFailures[sourceId]) throw new Error('source-unavailable');
  const meta = buildMeta(source);
  return JSON.stringify([meta.title, meta.workspacePath, meta.projectId, meta.permissionMode,
    meta.enabledMCPServers, meta.teamId, meta.appBinding, meta.importedFrom, meta.readOnly,
    settingsForConversation(sourceId, useSettingsStore.getState()).activeModel]);
}
async function publish(meta: ConversationMeta, identity: BranchIdentity): Promise<void> {
  await updateIndexEntry(meta);
  await flushIndex();
  await invokeElectronConversationBranch<BranchResult>('publish', identity);
  await catalogReindexConversation(meta.id, { strict: true });
  useChatStore.setState(state => ({ conversationIndex: { ...state.conversationIndex, [meta.id]: meta } }));
}
async function run(operation: Operation): Promise<string> {
  const identity = operation.identity;
  let result = await invokeElectronConversationBranch<BranchResult>('lookup', identity);
  if (result.state === 'absent') {
    const sourceId = identity.sourceConversationId;
    await waitForConversationPersistence(sourceId);
    const source = useChatStore.getState().conversations[sourceId];
    if (!source || useChatStore.getState().loadFailures[sourceId]) throw new Error('source-unavailable');
    await promoteStreamSnapshots(sourceId);
    const watermark = await flushAndGetLedgerWatermark(sourceId);
    await refreshOutputManifest(sourceId);
    const current = useChatStore.getState().conversations[sourceId];
    if (!current) throw new Error('source-unavailable');
    const text = { errorEmptyBody: getI18n().chat.errorEmptyBody };
    const prefix = conversationBranchPrefix(current.messages, sourceId, identity.targetMessageId, findToolResultImageSnapshot, text);
    const settings = settingsProof(sourceId);
    const model = settingsForConversation(sourceId, useSettingsStore.getState()).activeModel;
    await updateIndexEntry(buildMeta(current));
    await flushIndex();
    if (settingsProof(sourceId) !== settings) throw new Error('source-changed');
    result = await invokeElectronConversationBranch<BranchResult>('prepare', {
      ...identity, watermark, prefix, model, errorEmptyBody: text.errorEmptyBody, title: format(getI18n().chat.branch.title, { title: current.title }),
    });
    if (result.state === 'prepared') {
      let accepted = false;
      try {
        const latest = useChatStore.getState().conversations[sourceId];
        accepted = !!latest && settingsProof(sourceId) === settings
          && conversationBranchPrefix(latest.messages, sourceId, identity.targetMessageId, findToolResultImageSnapshot, text) === prefix;
      } finally {
        if (!accepted) await invokeElectronConversationBranch('discard', identity);
      }
      if (!accepted) throw new Error('source-changed');
      result = await invokeElectronConversationBranch<BranchResult>('commit', { ...identity, token: result.token });
    }
  }
  if (result.state !== 'committed' && result.state !== 'published') throw new Error('branch-not-committed');
  await publish(result.meta, identity);
  operation.completed = true;
  return identity.childConversationId;
}

/** A retry notice and the originating menu retain this same operation. */
export function createConversationBranch(sourceId: string, targetId: string, retry?: Operation): Promise<string> {
  const key = keyOf(sourceId, targetId);
  let operation = retry ?? operations.get(key);
  if (retry?.completed) return Promise.reject(new Error('branch-already-completed'));
  if (!operation || operation.completed) {
    operation = { identity: { sourceConversationId: sourceId, targetMessageId: targetId,
      childConversationId: crypto.randomUUID() }, completed: false };
    operations.set(key, operation);
  }
  if (operation.running) return operation.running;
  const selected = operation;
  selected.running = run(selected).finally(() => { selected.running = undefined; changed(); });
  changed();
  return selected.running;
}

export function requestConversationBranch(sourceId: string, targetId: string): void {
  const attempt = (operation?: Operation) => {
    if (operation?.completed) return;
    const initialId = useChatStore.getState().activeConversationId;
    const initialView = useSettingsStore.getState().viewMode;
    let navigated = false;
    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      if (state.activeConversationId !== previous.activeConversationId) navigated = true;
    });
    const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
      if (state.viewMode !== previous.viewMode) navigated = true;
    });
    const work = createConversationBranch(sourceId, targetId, operation);
    const selected = operation ?? operations.get(keyOf(sourceId, targetId))!;
    void work.then(async id => {
      await useChatStore.getState().loadConversation(id);
      if (!navigated && initialId === sourceId && initialView === 'chat'
        && useChatStore.getState().conversations[id]) await useChatStore.getState().switchConversation(id);
    }).catch((error: unknown) => {
      console.error('[conversation-branch] Creation failed', error);
      const t = getI18n();
      const code = error instanceof Error ? error.message : '';
      const message = /source-changed|source-unavailable|unavailable|incomplete/.test(code) ? t.chat.branch.selectionUnavailable
        : /invalid-history|watermark/.test(code) ? t.chat.branch.historyUnavailable : t.chat.branch.saveFailed;
      useToastStore.getState().addToast({ type: 'error', title: t.chat.branch.failed,
        message, duration: 0, dedupeKey: selected.identity.childConversationId,
        actions: [{ label: t.common.retry, onClick: () => attempt(selected) }] });
    }).finally(() => { unsubscribeChat(); unsubscribeSettings(); });
  };
  attempt();
}

export async function recoverConversationBranches(): Promise<void> {
  try {
    const failed = await invokeElectronConversationBranch<string[]>('cleanup');
    if (failed.length) throw new Error('preparation-cleanup-failed');
  } catch {
    const t = getI18n();
    useToastStore.getState().addToast({ type: 'error', title: t.chat.branch.failed, message: t.chat.branch.saveFailed, duration: 0,
      actions: [{ label: t.common.retry, onClick: () => { void recoverConversationBranches(); } }] });
  }
  let pending: string[];
  try {
    pending = await invokeElectronConversationBranch<string[]>('pending');
  } catch {
    const t = getI18n();
    useToastStore.getState().addToast({ type: 'error', title: t.chat.branch.failed, message: t.chat.branch.saveFailed, duration: 0,
      actions: [{ label: t.common.retry, onClick: () => { void recoverConversationBranches(); } }] });
    return;
  }
  for (const id of pending) if (!recoveries.has(id)) recoveries.set(id, { running: false });
  for (const [id, recovery] of recoveries) {
    if (recovery.running) continue;
    recovery.running = true;
    try {
      if (!recovery.committed) {
        const result = await invokeElectronConversationBranch<BranchResult>('recover', { childConversationId: id });
        if (result.state !== 'committed') throw new Error('invalid-recovery');
        recovery.committed = result;
      }
      const origin = recovery.committed.meta.branchOrigin;
      if (!origin) throw new Error('invalid-recovery');
      await publish(recovery.committed.meta, { childConversationId: id, sourceConversationId: origin.sourceConversationId, targetMessageId: origin.sourceMessageId });
      recoveries.delete(id);
    } catch {
      const t = getI18n();
      useToastStore.getState().addToast({ type: 'error', title: t.chat.branch.failed, message: t.chat.branch.saveFailed, duration: 0,
        actions: [{ label: t.common.retry, onClick: () => { void recoverConversationBranches(); } }] });
    } finally { recovery.running = false; }
  }
}
