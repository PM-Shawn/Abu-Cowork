import type { IMPlatform, IMReplyContext } from '../../types/im';
import type { IMChannel } from '../../types/imChannel';
import type { NormalizedIMMessage } from './inboundRouter';
import { sendFinal, sendThinking } from './streamingReply';
import type { AbuMessage } from './adapters/types';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { resolveCapability } from './authGate';

export const DEFAULT_IM_CONFIRMATION_TIMEOUT_MS = 180_000;
const TOMBSTONE_TTL_MS = DEFAULT_IM_CONFIRMATION_TIMEOUT_MS;
const MAX_TOMBSTONES = 500;
// This intentional 10,000 fail-closed cap assumes P0-D webhook signature verification prevents unauthenticated messageId flooding; post-verification TTL or pending-linked cleanup is tracked separately.
const MAX_NUMERIC_REPLY_IDS = 10_000;
const MAX_NUMERIC_REPLY_IDENTITY_COMPONENT_LENGTH = 512;
const MAX_NUMERIC_REPLY_IDENTITY_KEY_LENGTH = 2_048;
const DEFAULT_INVALID_REPLY_MESSAGE = '请只回复 1 或 2。';

export interface IMConfirmationTarget {
  platform: IMPlatform;
  channelId: string;
  senderId: string;
  chatId: string;
  threadId?: string;
  sessionWebhook?: string;
  sessionKey: string;
  conversationId: string;
  replyContext: IMReplyContext;
}

interface PendingConfirmation {
  requestId: number;
  target: IMConfirmationTarget;
  state: 'sending' | 'waiting' | 'settled';
  channelRef: IMChannel;
  channelAuthorityFingerprint: string;
  resolve: (confirmed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
  invalidReplyMessage: string;
}

let nextRequestId = 0;
const pendingBySession = new Map<string, PendingConfirmation>();
const tombstones = new Map<string, number>();
const consumedNumericReplyIds = new Set<string>();

function routeKey(target: Pick<IMConfirmationTarget, 'platform' | 'senderId' | 'chatId' | 'threadId'>): string {
  return [
    target.platform,
    target.senderId,
    target.chatId,
    target.threadId ?? '',
  ].join('\u001f');
}

function messageTargetKey(message: NormalizedIMMessage): string {
  return routeKey({
    platform: message.platform,
    senderId: message.senderId,
    chatId: message.chatId,
    threadId: message.replyContext.threadId,
  });
}

function numericReplyReplayKey(message: NormalizedIMMessage): string | null {
  const messageId = message.replyContext.messageId?.trim() ?? '';
  if (!messageId) return null;
  const components = [
    message.platform,
    message.senderId,
    message.chatId,
    message.replyContext.threadId ?? '',
    messageId,
  ];
  if (components.some((component) => component.length > MAX_NUMERIC_REPLY_IDENTITY_COMPONENT_LENGTH)) {
    return null;
  }
  const key = JSON.stringify(components);
  if (key.length > MAX_NUMERIC_REPLY_IDENTITY_KEY_LENGTH) return null;
  return key;
}

function observeNumericReplyId(message: NormalizedIMMessage): 'fresh' | 'duplicate' | 'missing-id' | 'capacity-full' {
  const key = numericReplyReplayKey(message);
  if (!key) return 'missing-id';
  if (consumedNumericReplyIds.has(key)) return 'duplicate';
  if (consumedNumericReplyIds.size >= MAX_NUMERIC_REPLY_IDS) return 'capacity-full';
  consumedNumericReplyIds.add(key);
  return 'fresh';
}

function routeTombstoneKeyFromMessage(message: NormalizedIMMessage): string {
  return messageTargetKey(message);
}

export function parseIMConfirmationReply(text: string): boolean | null {
  const trimmed = text.trim();
  if (trimmed === '1') return true;
  if (trimmed === '2') return false;
  return null;
}

function pruneTombstones(now: number): void {
  for (const [key, ts] of tombstones) {
    if (now - ts > TOMBSTONE_TTL_MS) tombstones.delete(key);
  }
  while (tombstones.size > MAX_TOMBSTONES) {
    const first = tombstones.keys().next().value;
    if (first === undefined) break;
    tombstones.delete(first);
  }
}

function addTombstone(target: IMConfirmationTarget): void {
  const now = Date.now();
  pruneTombstones(now);
  tombstones.set(routeKey(target), now);
}

function hasActiveTombstone(target: IMConfirmationTarget): boolean {
  const now = Date.now();
  pruneTombstones(now);
  return tombstones.has(routeKey(target));
}

function settle(pending: PendingConfirmation, confirmed: boolean): void {
  if (pending.state === 'settled') return;
  if (pendingBySession.get(pending.target.sessionKey) !== pending) return;
  pending.state = 'settled';
  pendingBySession.delete(pending.target.sessionKey);
  clearTimeout(pending.timer);
  pending.abortCleanup?.();
  addTombstone(pending.target);
  pending.resolve(confirmed);
}

function matchesTarget(message: NormalizedIMMessage, target: IMConfirmationTarget): boolean {
  return (
    message.platform === target.platform
    && message.senderId === target.senderId
    && message.chatId === target.chatId
    && (message.replyContext.threadId ?? '') === (target.threadId ?? '')
  );
}

function channelAuthorityFingerprint(channel: IMChannel): string {
  return JSON.stringify({
    id: channel.id,
    platform: channel.platform,
    enabled: channel.enabled,
    capability: channel.capability,
    allowedUsers: [...channel.allowedUsers].sort(),
    updatedAt: channel.updatedAt,
  });
}

function resolveChannelAuthority(target: IMConfirmationTarget): {
  allowed: boolean;
  channel?: IMChannel;
  fingerprint?: string;
} {
  const channel = useIMChannelStore.getState().channels[target.channelId];
  if (!channel || channel.enabled !== true || channel.platform !== target.platform) {
    return { allowed: false };
  }
  const auth = resolveCapability(target.senderId, channel);
  if (!auth.allowed || auth.capability !== 'full') {
    return { allowed: false };
  }
  return { allowed: true, channel, fingerprint: channelAuthorityFingerprint(channel) };
}

function isChannelAuthorityUnchanged(pending: PendingConfirmation): boolean {
  const authority = resolveChannelAuthority(pending.target);
  return Boolean(
    authority.allowed
    && authority.channel === pending.channelRef
    && authority.fingerprint === pending.channelAuthorityFingerprint,
  );
}

function consumeMatchingTombstone(message: NormalizedIMMessage): boolean {
  const now = Date.now();
  pruneTombstones(now);
  if (tombstones.has(routeTombstoneKeyFromMessage(message))) return true;
  for (const [key] of tombstones) {
    const parts = key.split('\u001f');
    if (
      parts[0] === message.platform
      && parts[1] === message.senderId
      && parts[2] === message.chatId
      && parts[3] === (message.replyContext.threadId ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function consumeRouteTombstone(target: IMConfirmationTarget): boolean {
  const now = Date.now();
  pruneTombstones(now);
  const key = routeKey(target);
  if (!tombstones.has(key)) return false;
  tombstones.delete(key);
  return true;
}

function sendInvalidReplyReminder(pending: PendingConfirmation): void {
  void sendThinking(pending.target.platform, pending.target.replyContext)
    .then((handle) => sendFinal(handle, { content: pending.invalidReplyMessage }))
    .catch(() => {});
}

export function consumeIMConfirmationReply(message: NormalizedIMMessage): boolean {
  const parsed = parseIMConfirmationReply(message.text);
  const numericIdStatus = parsed === null ? null : observeNumericReplyId(message);
  if (numericIdStatus === 'duplicate') return true;
  if (parsed !== null && consumeMatchingTombstone(message)) return true;

  for (const pending of pendingBySession.values()) {
    if (!matchesTarget(message, pending.target)) continue;
    if (parsed === null) {
      if (pending.state === 'waiting') sendInvalidReplyReminder(pending);
      return true;
    }
    if (pending.state !== 'waiting') return true;
    if (numericIdStatus !== 'fresh') {
      settle(pending, false);
      return true;
    }
    settle(pending, isChannelAuthorityUnchanged(pending) ? parsed : false);
    return true;
  }

  return parsed !== null;
}

export function cancelIMConfirmationForSession(sessionKey: string): void {
  const pending = pendingBySession.get(sessionKey);
  if (pending) settle(pending, false);
}

export function cancelAllIMConfirmations(): void {
  for (const pending of [...pendingBySession.values()]) {
    settle(pending, false);
  }
}

export function getPendingIMConfirmationCount(): number {
  return pendingBySession.size;
}

export function __resetIMConfirmationRelayForTests(): void {
  for (const pending of [...pendingBySession.values()]) {
    pending.state = 'settled';
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    pending.resolve(false);
  }
  pendingBySession.clear();
  tombstones.clear();
  consumedNumericReplyIds.clear();
}

export function __getIMConfirmationNumericReplyGuardSizeForTests(): number {
  return consumedNumericReplyIds.size;
}

export async function requestIMConfirmation(
  target: IMConfirmationTarget,
  message: AbuMessage,
  options: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    invalidReplyMessage?: string;
    allowRouteRearm?: boolean;
  } = {},
): Promise<boolean> {
  if (pendingBySession.has(target.sessionKey)) return false;
  if (options.abortSignal?.aborted) return false;
  const hasTombstone = hasActiveTombstone(target);
  if (hasTombstone && (!options.allowRouteRearm || !target.replyContext.messageId?.trim())) return false;
  const authority = resolveChannelAuthority(target);
  if (!authority.allowed || !authority.channel || !authority.fingerprint) return false;
  const channelRef = authority.channel;
  const channelAuthority = authority.fingerprint;

  return new Promise<boolean>((resolve) => {
    if (hasTombstone && !consumeRouteTombstone(target)) {
      resolve(false);
      return;
    }
    const requestId = ++nextRequestId;
    const pending: PendingConfirmation = {
      requestId,
      target,
      state: 'sending',
      channelRef,
      channelAuthorityFingerprint: channelAuthority,
      resolve,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      invalidReplyMessage: options.invalidReplyMessage ?? DEFAULT_INVALID_REPLY_MESSAGE,
    };
    pending.timer = setTimeout(() => settle(pending, false), options.timeoutMs ?? DEFAULT_IM_CONFIRMATION_TIMEOUT_MS);
    const abort = () => settle(pending, false);
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', abort, { once: true });
      pending.abortCleanup = () => options.abortSignal?.removeEventListener('abort', abort);
    }
    pendingBySession.set(target.sessionKey, pending);

    void sendThinking(target.platform, target.replyContext)
      .then((handle) => sendFinal(handle, message))
      .then((result) => {
        if (pendingBySession.get(target.sessionKey) !== pending || pending.requestId !== requestId) return;
        if (!result.success || result.error?.startsWith('no_direct_reply:')) {
          settle(pending, false);
          return;
        }
        pending.state = 'waiting';
      })
      .catch(() => {
        settle(pending, false);
      });
  });
}
