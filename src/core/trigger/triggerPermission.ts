/**
 * Trigger Permission Resolution
 *
 * Generates commandConfirmCallback / filePermissionCallback / blockedTools
 * based on the trigger's capability level. Same pattern as IM authGate.
 *
 * Core principle: authorize at creation time, execute without prompts at runtime.
 */

import type { TriggerAction, TriggerCapability, TriggerPermissions } from '../../types/trigger';
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { listAllBrowserToolPatterns } from '../permissions/browserToolPolicy';
import { READ_ONLY_TOOL_ALLOWLIST } from '../permissions/readOnlyToolPolicy';
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
  allowedTools?: string[];
}

/**
 * Resolve permission callbacks for a trigger based on its capability level.
 * Pre-authorizes workspace and allowed paths before execution.
 */
export function resolveTriggerCallbacks(action: TriggerAction): TriggerCallbacks {
  const capability = action.capability ?? 'read_tools';

  // Pre-authorize the workspace path with the rights the tier actually
  // promises — NOT authorizeWorkspace's read+write default. An authorized
  // workspace short-circuits `checkWritePath` inside registry.ts *before*
  // `filePermissionCallback` is ever consulted, so a blanket read+write grant
  // here silently overrides the read-only callback below: a 'read_tools'
  // trigger ("reads information, changes nothing") could write anywhere
  // inside its own workspace. b4ce62e8 closed exactly this hole on the
  // scheduler side and its own commit note flagged the trigger path as still
  // open; this closes it. (Note the map only ever *adds* capabilities — if
  // the same directory was already authorized read+write by an interactive
  // session, that standing grant still applies; this stops the trigger from
  // minting the write grant itself.)
  if (action.workspacePath) {
    authorizeWorkspace(
      action.workspacePath,
      capability === 'read_tools' ? ['read'] : ['read', 'write'],
    );
  }

  // Pre-authorize custom allowed paths
  if (capability === 'custom' && action.permissions?.allowedPaths) {
    for (const p of action.permissions.allowedPaths) {
      authorizeWorkspace(p);
    }
  }

  // Triggers never need UI-only tools
  const blockedTools = buildBlockedTools(capability);

  switch (capability) {
    case 'read_tools':
      return {
        // Kept as the last line of defence for anything that still reaches a
        // confirmation, but it is no longer what makes this tier read-only:
        // the strategy resolves a workspace-internal `safe` command to
        // 'allow' without ever calling it (RB-02). `allowedTools` below is
        // the actual ceiling.
        commandConfirmCallback: async (info) => {
          console.log(`[Trigger] read_tools: denied command "${info.command}"`);
          return false;
        },
        filePermissionCallback: async (req) => {
          if (req.capability === 'read') {
            // Auto-allow reads for pre-authorized workspaces (read-only)
            const permStore = usePermissionStore.getState();
            if (permStore.hasPermission(req.path, 'read')) {
              authorizeWorkspace(req.path, ['read']);
              return true;
            }
          }
          console.log(`[Trigger] read_tools: denied ${req.capability} "${req.path}"`);
          return false;
        },
        blockedTools,
        allowedTools: [...READ_ONLY_TOOL_ALLOWLIST],
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
    allowedTools: permissions?.allowedTools,
  };
}

function buildBlockedTools(capability: TriggerCapability): string[] {
  // request_workspace is always blocked — triggers can't pop UI dialogs
  const blocked: string[] = [TOOL_NAMES.REQUEST_WORKSPACE];

  // read_tools promises "reads information, changes nothing" — the read-only
  // tier carries no browser capability at all (a user correction reversed an
  // earlier design that kept `navigate` available for "view web pages"; the
  // rule is now a single sentence: read_tools has no browser access, period).
  // The confirmation callback below cannot deliver that on its own: a
  // persistent per-site grant makes `registry.ts` resolve the browser gate to
  // 'allow' without ever calling the callback, so on any site the user once
  // chose "always allow this site" for, an unattended read-only run could
  // still click, type, navigate and run page scripts unasked. Remove every
  // browser-automation tool from the run instead — the tier is the ceiling
  // and has to hold above the site grant.
  if (capability === 'read_tools') {
    blocked.push(...listAllBrowserToolPatterns());
  }

  return blocked;
}
