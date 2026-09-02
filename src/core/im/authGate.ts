/**
 * AuthGate — User authentication + capability level determination
 *
 * Rules:
 * 1. config.allowedUsers is non-empty AND user not in list → denied
 * 2. config.capability === 'full' AND user not in allowedUsers → downgrade to safe_tools
 * 3. Otherwise → use config.capability
 */

import type { IMChannel, IMCapabilityLevel } from '../../types/imChannel';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { listAllBrowserToolPatterns } from '../permissions/browserToolPolicy';
import {
  createUnattendedConfirmation,
  mayUnattendedTierApproveBrowser,
  type UnattendedImTarget,
} from '../permissions/unattendedConfirmation';
import { getReadOnlyRunToolAllowlist, getSafeRunToolAllowlist } from '../permissions/runPermissionCeiling';
import { TOOL_NAMES } from '../tools/toolNames';

export type AuthResult =
  | { allowed: true; capability: IMCapabilityLevel }
  | { allowed: false; reason: string };

/**
 * Determine whether a user is allowed to interact and at what capability level.
 */
export function resolveCapability(
  userId: string,
  channel: IMChannel,
): AuthResult {
  // 1. Whitelist check (if configured)
  if (channel.allowedUsers.length > 0 && !channel.allowedUsers.includes(userId)) {
    return { allowed: false, reason: 'User not in whitelist' };
  }

  // 2. Full capability requires explicit whitelist
  if (channel.capability === 'full' && !channel.allowedUsers.includes(userId)) {
    return { allowed: true, capability: 'safe_tools' };
  }

  // 3. Use configured capability
  return { allowed: true, capability: channel.capability };
}

/**
 * Build agentLoop callbacks for the given capability level.
 * Reuses existing permission infrastructure.
 */
export function getCallbacksForLevel(
  level: IMCapabilityLevel,
  /** Run provenance for the unattended confirmation seam — where an approval
   *  request would be delivered, once there is one to deliver. */
  run?: { conversationId?: string; imTarget?: UnattendedImTarget },
): {
  disableTools?: boolean;
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
} {
  const denyingConfirm = (tier: IMCapabilityLevel) => createUnattendedConfirmation({
    source: 'im',
    ...(run?.conversationId !== undefined ? { conversationId: run.conversationId } : {}),
    ...(run?.imTarget !== undefined ? { imTarget: run.imTarget } : {}),
    onDenied: (reason, info) => {
      console.log(`[IM] ${tier}: denied "${info.command}" (${reason})`);
    },
  });
  switch (level) {
    case 'chat_only':
      return {
        disableTools: true,
        commandConfirmCallback: denyingConfirm('chat_only'),
        filePermissionCallback: async () => false,
      };
    case 'read_tools':
      return {
        commandConfirmCallback: denyingConfirm('read_tools'),
        filePermissionCallback: async (req) => req.capability === 'read',
      };
    case 'safe_tools':
      return {
        commandConfirmCallback: denyingConfirm('safe_tools'),
        // channelRouter pre-authorizes this run's declared workspace in its
        // scoped map. Reaching the callback means the request is outside that
        // scope; never import a standing desktop/global permission into IM.
        filePermissionCallback: async () => false,
      };
    case 'full':
      return {
        // A capability tier is a CEILING — it may only remove authority, never
        // add it. This callback used to be `async () => true`, which meant a
        // chat message on a `full` channel auto-approved EVERY browser
        // confirmation, `execute_js` included: arbitrary code inside the
        // user's logged-in sessions, approved by nobody. The browser
        // operation-class policy is therefore evaluated here independently of
        // the tier, so `full` can never be looser than the unattended column
        // says. (`registry.ts` also decides this before any callback runs;
        // this is the second lock, so a future gate refactor or a new caller
        // of `getCallbacksForLevel` cannot reopen the hole.)
        commandConfirmCallback: async (info) => {
          if (info.kind === 'browser' && !mayUnattendedTierApproveBrowser(info)) {
            console.log(`[IM] full: browser action "${info.command}" denied by the unattended browser policy`);
            return false;
          }
          return true;
        },
        filePermissionCallback: async () => true,
      };
  }
}

/**
 * Tools removed from an IM run before the model ever sees them, by tier.
 *
 * Mirrors `triggerPermission.ts`'s `buildBlockedTools` and shares its single
 * source for the browser patterns (`listAllBrowserToolPatterns`) rather than
 * repeating the namespace list — an unattended IM channel is the same
 * question as an unattended trigger.
 *
 * - `request_workspace` is always blocked: an IM run can never answer a UI
 *   dialog.
 * - `read_tools` carries NO browser capability at all. The confirmation
 *   callback cannot deliver that on its own: a persistent per-site grant
 *   makes `registry.ts` resolve the browser gate to 'allow' without ever
 *   calling the callback, so on a site the user once chose "always allow"
 *   for, a read-only IM run could still click, type, navigate and run page
 *   scripts unasked. The tier is the CEILING, so it has to hold above the
 *   site grant — at tool-list level.
 * - `chat_only` also gets the patterns for consistency, though
 *   `getCallbacksForLevel` already disables tools entirely for it.
 * - `safe_tools` needs no browser block patterns here because its positive
 *   roster omits the whole browser namespace. `full` is unrestricted here.
 */
export function getBlockedToolsForLevel(level: IMCapabilityLevel): string[] {
  // `ask_user_question` renders a blocking selection card that only the desktop
  // UI can answer — in an IM run it would stall the turn until timeout while the
  // remote user never sees it. Block it at every IM tier so the model instead
  // asks in plain text and ends the turn; the user's next message resumes the
  // conversation naturally (report_plan's approval gate is handled the same way,
  // inside its own IM branch).
  const blocked: string[] = [TOOL_NAMES.REQUEST_WORKSPACE, TOOL_NAMES.ASK_USER_QUESTION];
  if (level === 'read_tools' || level === 'chat_only') {
    blocked.push(...listAllBrowserToolPatterns());
  }
  return blocked;
}

/**
 * The tier's positive ceiling — the twin of `getBlockedToolsForLevel`, and
 * the IM half of the RB-02 fix (`triggerPermission.ts` carries the trigger
 * half). `read_tools` is capped at `READ_ONLY_TOOL_ALLOWLIST` because its
 * `commandConfirmCallback` above is never consulted for a workspace-internal
 * command the strategy already resolved to 'allow'.
 *
 * Returns `undefined` — not `[]` — for `full`, the one tier with no allowlist:
 * every enforcement point treats an EMPTY array as "no restriction"
 * (`allowedTools?.length && ...`), so an empty array would read as
 * unrestricted rather than as "nothing allowed". `chat_only` therefore uses
 * an explicit deny-all sentinel even though its callbacks also disable tools.
 */
export function getAllowedToolsForLevel(level: IMCapabilityLevel): string[] | undefined {
  if (level === 'chat_only') return ['__chat_only_no_tools__'];
  if (level === 'read_tools') return getReadOnlyRunToolAllowlist();
  if (level === 'safe_tools') return getSafeRunToolAllowlist();
  return undefined;
}
