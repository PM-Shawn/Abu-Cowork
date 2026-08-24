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
import { usePermissionStore } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import { listAllBrowserToolPatterns } from '../permissions/browserToolPolicy';
import { READ_ONLY_TOOL_ALLOWLIST } from '../permissions/readOnlyToolPolicy';
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
export function getCallbacksForLevel(level: IMCapabilityLevel): {
  disableTools?: boolean;
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
} {
  switch (level) {
    case 'chat_only':
      return {
        disableTools: true,
        commandConfirmCallback: async () => false,
        filePermissionCallback: async () => false,
      };
    case 'read_tools':
      return {
        commandConfirmCallback: async () => false,
        filePermissionCallback: async (req) => req.capability === 'read',
      };
    case 'safe_tools':
      return {
        commandConfirmCallback: async (info) => {
          // Only allow commands classified as 'safe' by commandSafety (same as trigger behavior)
          const allowed = info.level === 'safe';
          if (!allowed) {
            console.log(`[IM] safe_tools: denied ${info.level} command "${info.command}"`);
          }
          return allowed;
        },
        filePermissionCallback: async (request) => {
          const permStore = usePermissionStore.getState();
          if (permStore.hasPermission(request.path, request.capability)) {
            authorizeWorkspace(request.path);
            return true;
          }
          return false;
        },
      };
    case 'full':
      return {
        commandConfirmCallback: async () => true,
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
 * - `safe_tools` / `full` are unchanged: `request_workspace` only.
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
 * Returns `undefined` — not `[]` — for the tiers that carry no allowlist:
 * every enforcement point treats an EMPTY array as "no restriction"
 * (`allowedTools?.length &&  ...`), so an empty array would read as
 * unrestricted rather than as "nothing allowed". `chat_only` is deliberately
 * absent for the same reason: `getCallbacksForLevel` disables tools outright
 * for it, and handing it a read allowlist here could only ever widen that.
 */
export function getAllowedToolsForLevel(level: IMCapabilityLevel): string[] | undefined {
  return level === 'read_tools' ? [...READ_ONLY_TOOL_ALLOWLIST] : undefined;
}
