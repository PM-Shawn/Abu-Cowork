/**
 * Trigger Permission Resolution
 *
 * Generates commandConfirmCallback / filePermissionCallback / blockedTools
 * based on the trigger's capability level. Same pattern as IM authGate.
 *
 * Core principle: authorize at creation time, execute without prompts at runtime.
 */

import type { TriggerAction, TriggerPermissions } from '../../types/trigger';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { authorizeWorkspace } from '../tools/pathSafety';
import { usePermissionStore } from '../../stores/permissionStore';
import { TOOL_NAMES } from '../tools/toolNames';

/** Simple glob matching for command patterns (e.g. "npm run *", "git *") */
function matchCommandGlob(command: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(command);
}

export interface TriggerCallbacks {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  blockedTools: string[];
}

/**
 * Resolve permission callbacks for a trigger based on its capability level.
 * Pre-authorizes workspace and allowed paths before execution.
 */
export function resolveTriggerCallbacks(action: TriggerAction): TriggerCallbacks {
  const capability = action.capability ?? 'read_tools';

  // Pre-authorize workspace path
  if (action.workspacePath) {
    authorizeWorkspace(action.workspacePath);
  }

  // Pre-authorize custom allowed paths
  if (capability === 'custom' && action.permissions?.allowedPaths) {
    for (const p of action.permissions.allowedPaths) {
      authorizeWorkspace(p);
    }
  }

  // Triggers never need UI-only tools
  const blockedTools = buildBlockedTools(capability, action.permissions);

  switch (capability) {
    case 'read_tools':
      return {
        commandConfirmCallback: async (info) => {
          console.log(`[Trigger] read_tools: denied command "${info.command}"`);
          return false;
        },
        filePermissionCallback: async (req) => {
          if (req.capability === 'read') {
            // Auto-allow reads for pre-authorized workspaces
            const permStore = usePermissionStore.getState();
            if (permStore.hasPermission(req.path, 'read')) {
              authorizeWorkspace(req.path);
              return true;
            }
          }
          console.log(`[Trigger] read_tools: denied ${req.capability} "${req.path}"`);
          return false;
        },
        blockedTools,
      };

    case 'safe_tools':
      return {
        commandConfirmCallback: async (info) => {
          // Only allow commands classified as 'safe' by commandSafety
          const allowed = info.level === 'safe';
          if (!allowed) {
            console.log(`[Trigger] safe_tools: denied ${info.level} command "${info.command}"`);
          }
          return allowed;
        },
        filePermissionCallback: async (req) => {
          const permStore = usePermissionStore.getState();
          if (permStore.hasPermission(req.path, req.capability)) {
            authorizeWorkspace(req.path);
            return true;
          }
          console.log(`[Trigger] safe_tools: denied ${req.capability} "${req.path}"`);
          return false;
        },
        blockedTools,
      };

    case 'full':
      return {
        commandConfirmCallback: async (info) => {
          // Allow everything except hard-blocked commands
          const allowed = info.level !== 'block';
          if (!allowed) {
            console.log(`[Trigger] full: blocked command "${info.command}" (${info.reason})`);
          }
          return allowed;
        },
        filePermissionCallback: async (req) => {
          // Auto-allow all file access (pathSafety hard blocks still apply in executeAnyTool)
          authorizeWorkspace(req.path);
          return true;
        },
        blockedTools,
      };

    case 'custom':
      return buildCustomCallbacks(action.permissions, blockedTools);
  }
}

function buildCustomCallbacks(
  permissions: TriggerPermissions | undefined,
  blockedTools: string[],
): TriggerCallbacks {
  const allowedCommands = permissions?.allowedCommands;

  return {
    commandConfirmCallback: async (info) => {
      if (info.level === 'block') return false;
      if (!allowedCommands || allowedCommands.length === 0) {
        console.log(`[Trigger] custom: no allowedCommands, denied "${info.command}"`);
        return false;
      }
      const allowed = allowedCommands.some((pattern) =>
        matchCommandGlob(info.command, pattern),
      );
      if (!allowed) {
        console.log(`[Trigger] custom: command "${info.command}" not in whitelist`);
      }
      return allowed;
    },
    filePermissionCallback: async (req) => {
      const permStore = usePermissionStore.getState();
      if (permStore.hasPermission(req.path, req.capability)) {
        authorizeWorkspace(req.path);
        return true;
      }
      console.log(`[Trigger] custom: denied ${req.capability} "${req.path}"`);
      return false;
    },
    blockedTools,
  };
}

function buildBlockedTools(
  capability: string,
  permissions: TriggerPermissions | undefined,
): string[] {
  // request_workspace is always blocked — triggers can't pop UI dialogs
  const blocked = [TOOL_NAMES.REQUEST_WORKSPACE];

  // For custom capability with tool whitelist, we don't add extra blocks here
  // because tool filtering is handled via allowedTools in the agent loop options.
  // But we record the intent for the engine to pass through.
  if (capability === 'custom' && permissions?.allowedTools?.length) {
    // Tool whitelist is enforced separately — see triggerEngine.executeAction
  }

  return blocked;
}
