/**
 * Notice System — public API barrel.
 *
 * Producers import `publish` to emit notices.
 * UI components import `registerChannel` to receive targeted dispatch.
 * Legacy code can still use `subscribe` for blanket fan-out (migration).
 */

export { publish, subscribe } from './bus';
export type { DeliveryChannel, NoticeHandler, Unsubscribe } from './bus';

export { registerChannel, setContextProvider } from './pipeline';
export type { GateContextProvider, ChannelHandler, PipelineResult } from './pipeline';

export { route } from './router';
export type { DeliveryTarget } from './router';

export { filter } from './gate';
export type { GateContext, GateDecision, FeedbackRule, PetState } from './gate';

export { checkL2Quota, consumeL2Quota } from './quota';

export { queryAudit, aggregateDecisions } from './audit';
export type { AuditEntry } from './audit';

export { queueToInbox, getPendingInbox, markDelivered, cleanupInbox, drainInbox } from './inbox';
export type { InboxEntry } from './inbox';

export type {
  Notice,
  NoticeTier,
  NoticeType,
  NoticeSource,
  PublishInput,
} from './types';
export { DEFAULT_TIER, DEFAULT_TTL_MS } from './types';
