import type { Message } from '@/types';
import { getConversationBranchEligibility, ConversationBranchHistoryError } from './conversationBranchHistory';
import { stripForDisk, type FindToolResultImageSnapshot } from './ledgerLineSerializer';
import type { ConversationMeta } from './conversationWriter';
import { sanitizeLoadedLedgerMessages, type LoadedMessageSanitizerText } from './loadedMessageSanitizer';

export interface BranchIdentity {
  sourceConversationId: string;
  targetMessageId: string;
  childConversationId: string;
}

export interface BranchPrepareRequest extends BranchIdentity {
  watermark: number;
  prefix: string;
  title: string;
  errorEmptyBody: string;
  model?: { providerId: string; modelId: string };
}

export type BranchResult =
  | { state: 'absent' }
  | { state: 'prepared'; token: string }
  | { state: 'committed' | 'published'; meta: ConversationMeta };

/** Both live and reloaded histories use the shared reader and writer projections. */
export function conversationBranchPrefix(
  messages: readonly Message[], sourceConversationId: string, targetMessageId: string,
  findToolResultImageSnapshot: FindToolResultImageSnapshot,
  text: LoadedMessageSanitizerText = { errorEmptyBody: '' },
): string {
  const eligibility = getConversationBranchEligibility(messages, targetMessageId, true);
  if (!eligibility.eligible) throw new ConversationBranchHistoryError(eligibility.reason);
  const history = sanitizeLoadedLedgerMessages([...messages.slice(0, eligibility.targetIndex + 1)], { text });
  return JSON.stringify(history.map(message => {
    const disk = stripForDisk(message, sourceConversationId, { findToolResultImageSnapshot });
    const result = { ...disk } as Message & { pid?: string; lk?: string };
    delete result.pid;
    delete result.lk;
    return result;
  }));
}
