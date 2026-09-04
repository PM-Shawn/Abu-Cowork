/**
 * Where an automatic run may ask for approval.
 *
 * ## The gap this closes
 *
 * Batch 2 shipped「每次询问」as a real option in the automatic-tasks column,
 * and `pendingApprovals.ts` shipped the IM round-trip that is supposed to
 * answer it. They were never connected. `askOverIm` resolves its channel from
 * a caller-supplied `imTarget` or, failing that, from the IM SESSION bound to
 * the run's conversation — and only `channelRouter.ts` (an IM-originated run)
 * supplied either. A scheduled task mints a fresh conversation on every run
 * and a trigger run binds no session, so the lookup always came back null and
 * every「每次询问」in an automatic task refused itself with `no_binding`.
 *
 * The user had already told us where to reach them: the automation's IM output
 * binding, the channel their RESULTS go to. This module turns that binding
 * into an approval target, so the prompt lands exactly where the results land.
 *
 * ## Who may answer (U3's rules, unchanged)
 *
 * This module only decides WHERE to ask and WHO owns the ask. The matching
 * itself stays in `pendingApprovals.tryConsumeApprovalReply`:
 *
 * - `senderId` set → only that person's reply counts, in the addressed chat.
 *   A group is not a voting booth: a bystander must never be able to approve
 *   an action running inside someone else's signed-in browser sessions.
 * - `senderId` absent → only a reply from a PRIVATE chat counts (U3 M5:
 *   unknown owner ⇒ private-only). A prompt sent to a group with no bound
 *   owner is therefore unanswerable by construction and expires — fail-closed,
 *   and the reason the settings copy tells users to name a DM recipient.
 *
 * ## Deliberately NOT here
 *
 * No fallback invention. If the automation names no channel, this returns null
 * and the caller keeps the old behavior (session lookup, then refuse). Guessing
 * a channel — "the only one configured", "the last one used" — would route a
 * 3am approval for someone's bank session into a chat they never nominated.
 */

import { useIMChannelStore } from '../../stores/imChannelStore';
import type { UnattendedImTarget } from '../permissions/unattendedConfirmation';

/**
 * The subset of a scheduled task's / trigger's IM output config this reads.
 * Structural on purpose: `ScheduledTask` and `TriggerOutput` spell these four
 * fields identically, and importing either type here would put a core/im
 * module on the scheduler's and the trigger's type graph for no gain.
 */
export interface ImOutputBinding {
  outputChannelId?: string | undefined;
  /** Comma-separated group chat ids. */
  outputChatIds?: string | undefined;
  /** Comma-separated user ids, addressed as a DM. */
  outputUserIds?: string | undefined;
}

/** First non-empty entry of a comma-separated id list, or null. */
function firstId(list: string | undefined): string | null {
  if (!list) return null;
  for (const raw of list.split(',')) {
    const id = raw.trim();
    if (id) return id;
  }
  return null;
}

/**
 * Build the approval target for an automatic run, or null when the automation
 * has nominated nowhere to ask.
 *
 * Addressing follows `pushToIMChannel` exactly — chat ids first, then user
 * ids as DMs — so an approval prompt and the run's results reach the same
 * place. Only the FIRST id is used: an approval is a decision, and fanning one
 * out to five chats would mean five people racing to answer a question only
 * one answer can settle.
 */
export function resolveUnattendedImTarget(
  binding: ImOutputBinding | undefined,
): UnattendedImTarget | null {
  const channelId = binding?.outputChannelId;
  if (!channelId) return null;

  // The platform decides which adapter sends, and which inbound messages can
  // possibly match. A channel the user has since deleted is not a target.
  const channel = useIMChannelStore.getState().channels?.[channelId];
  if (!channel?.platform) return null;

  // The owner of the ask, when the automation names one. Used even with a
  // chat target: "post it in the team room, but only Li may approve it".
  const ownerId = firstId(binding?.outputUserIds);
  const chatId = firstId(binding?.outputChatIds);

  if (chatId) {
    return {
      platform: channel.platform,
      channelId,
      chatId,
      chatIdType: 'chat_id',
      ...(ownerId !== null ? { senderId: ownerId } : {}),
    };
  }
  if (ownerId) {
    // DM: the id addresses a PERSON, and the person addressed is by definition
    // the owner of the ask.
    return {
      platform: channel.platform,
      channelId,
      chatId: ownerId,
      chatIdType: 'open_id',
      senderId: ownerId,
    };
  }
  // A channel with no chat and no user is not somewhere a message can be sent.
  return null;
}
