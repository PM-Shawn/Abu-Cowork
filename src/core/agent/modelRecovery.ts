import type { ActiveModel } from '@/types/provider';
import type { SettingsState } from '@/stores/settingsStore';
import { getSettingsReader } from './ports/settingsReader';
import { getActiveApiKey, getActiveProvider, getModelUnavailableReason, providerRequiresApiKey } from '@/utils/settingsSelectors';
import { resolveEffectiveLlmCreds } from '@/core/enterprise/llm-resolver';
import { resolveDelegatedModelCapabilities } from './delegatedModelCapabilities';
import type { ModelRecoveryReason, RunModelBinding } from './ports/modelRecovery';
import { onSidecarRequest } from '@/core/sidecar/sidecarManager';
import { resolveCapabilities } from '@/core/llm/modelCapabilities';
import { applyDeclaredCapabilities } from '@/core/llm/applyDeclaredCapabilities';
import { resolveDelegatedDeclaredCapabilities } from './delegatedModelCapabilities';
import { adapterKindFor } from '@/core/llm/adapterKind';
import { preflightDelegatedMedia } from '@/core/subagent/delegatedMediaPreflight';
import type { Message } from '@/types';

export interface PendingModelRecovery {
  id: string;
  conversationId: string;
  agentName?: string;
  model: ActiveModel;
  reason: ModelRecoveryReason;
}

interface RecoveryOwner {
  conversationId: string;
  agentName?: string;
  signal: AbortSignal;
  interactive: boolean;
  getBinding: () => RunModelBinding;
  isCurrent: () => boolean;
  onSelected: (binding: RunModelBinding) => void;
  onWaitingChange?: (waiting: boolean) => void;
  acceptsModel?: (binding: RunModelBinding) => boolean;
}

interface RecoverySession {
  owner: RecoveryOwner;
  pending?: {
    snapshot: PendingModelRecovery;
    promise: Promise<RunModelBinding | null>;
    resolve: (binding: RunModelBinding | null) => void;
  };
  removeAbort: () => void;
}

const sessions = new Map<string, RecoverySession>();
const listeners = new Set<() => void>();
let snapshots: PendingModelRecovery[] = [];
let nextRequestId = 0;

function publish(): void {
  snapshots = [...sessions.values()].flatMap((session) => session.pending ? [session.pending.snapshot] : []);
  for (const listener of listeners) listener();
}

function settle(session: RecoverySession, binding: RunModelBinding | null): void {
  const pending = session.pending;
  if (!pending) return;
  session.pending = undefined;
  session.owner.onWaitingChange?.(false);
  pending.resolve(binding);
  publish();
}

export function buildRunModelBinding(
  settingsSnapshot: SettingsState,
  model: ActiveModel,
  revision: number,
): RunModelBinding {
  const scoped = { ...settingsSnapshot, activeModel: { ...model } };
  const provider = getActiveProvider(scoped);
  if (!provider) throw new Error('The selected model provider is unavailable');
  return {
    revision,
    model: { ...model },
    settingsSnapshot: scoped,
    resolvedCreds: resolveEffectiveLlmCreds(getActiveApiKey(scoped), provider.baseUrl || undefined),
    capabilities: resolveDelegatedModelCapabilities(undefined, scoped),
  };
}

export function registerModelRecovery(runId: string, owner: RecoveryOwner): () => void {
  if (sessions.has(runId)) throw new Error('Model recovery run is already registered');
  const session: RecoverySession = { owner, removeAbort: () => owner.signal.removeEventListener('abort', abort) };
  const abort = () => settle(session, null);
  sessions.set(runId, session);
  onSidecarRequest('model.recovery.wait', handleModelRecoveryRequest);
  owner.signal.addEventListener('abort', abort, { once: true });
  return () => {
    if (sessions.get(runId) !== session) return;
    settle(session, null);
    sessions.delete(runId);
    session.removeAbort();
  };
}

export function requestModelRecovery(runId: string, expectedRevision: number, reason: ModelRecoveryReason): Promise<RunModelBinding | null> {
  const session = sessions.get(runId);
  if (!session) throw new Error('Model recovery run is unavailable');
  const { owner } = session;
  if (!owner.isCurrent() || owner.signal.aborted || !owner.interactive) return Promise.resolve(null);
  const binding = owner.getBinding();
  if (binding.revision !== expectedRevision) throw new Error('Model recovery binding is stale');
  if (session.pending) return session.pending.promise;
  let resolve!: (binding: RunModelBinding | null) => void;
  const promise = new Promise<RunModelBinding | null>((done) => { resolve = done; });
  session.pending = {
    snapshot: { id: `model-recovery-${++nextRequestId}`, conversationId: owner.conversationId,
      agentName: owner.agentName, model: binding.model, reason },
    promise,
    resolve,
  };
  owner.onWaitingChange?.(true);
  publish();
  return promise;
}

function handleModelRecoveryRequest(raw: unknown): Promise<RunModelBinding | null> {
  const params = raw as { runId?: unknown; expectedRevision?: unknown; reason?: unknown } | null;
  if (!params || typeof params.runId !== 'string' || typeof params.expectedRevision !== 'number'
    || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0
    || (params.reason !== 'quota' && params.reason !== 'context-window')) {
    throw new Error('Invalid model recovery request');
  }
  return requestModelRecovery(params.runId, params.expectedRevision, params.reason);
}

/** Only the shell UI can submit a selection. No reverse RPC exposes this action. */
export function selectRecoveryModel(requestId: string, model: ActiveModel): 'unavailable' | 'credentials-required' | 'incompatible' | 'ended' | null {
  const session = [...sessions.values()].find((candidate) => candidate.pending?.snapshot.id === requestId);
  if (!session || session.owner.signal.aborted || !session.owner.isCurrent()) return 'ended';
  const settings = getSettingsReader().getSnapshot();
  if (getModelUnavailableReason(settings, model)) return 'unavailable';
  const binding = buildRunModelBinding(settings, model, session.owner.getBinding().revision + 1);
  if (providerRequiresApiKey(binding.settingsSnapshot) && !binding.resolvedCreds.apiKey) return 'credentials-required';
  if (session.owner.acceptsModel?.(binding) === false) return 'incompatible';
  if (session.owner.signal.aborted || !session.owner.isCurrent() || session.pending?.snapshot.id !== requestId) return 'ended';
  session.owner.onSelected(binding);
  settle(session, binding);
  return null;
}

export function subscribeModelRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function recoveryAcceptsMedia(binding: RunModelBinding, messages: readonly Message[], delegatedTurn?: unknown, mediaFallback?: 'text-only'): boolean {
  const provider = getActiveProvider(binding.settingsSnapshot);
  const caps = applyDeclaredCapabilities(resolveCapabilities(binding.model.modelId), resolveDelegatedDeclaredCapabilities(provider, binding.model.modelId));
  const adapterKind = adapterKindFor(provider, binding.resolvedCreds.forceOpenAiCompatible);
  if (preflightDelegatedMedia(delegatedTurn, caps, binding.model.modelId, adapterKind, mediaFallback).kind === 'error') return false;
  return messages.every((message) => message.role !== 'user' || !Array.isArray(message.content) || message.content.every((block) => {
    if (block.type === 'image') return caps.vision;
    if (block.type === 'document') return !!caps.documentBlock && adapterKind === 'claude';
    return true;
  }));
}

export function getPendingModelRecovery(conversationId: string): PendingModelRecovery | null {
  return snapshots.find((entry) => entry.conversationId === conversationId) ?? null;
}
