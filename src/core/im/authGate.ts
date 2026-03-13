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
        commandConfirmCallback: async () => {
          // Auto-deny dangerous commands (same as trigger behavior)
          return false;
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
