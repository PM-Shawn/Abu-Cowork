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
import {
  getReadOnlyRunToolAllowlist,
  getSafeRunToolAllowlist,
  normalizeCustomRunCommandAllowlist,
  normalizeCustomRunToolAllowlist,
  normalizeTriggerRunCapability,
} from '../permissions/runPermissionCeiling';
import { scopedAuthorizeWorkspace } from '../tools/pathSafety';
import {
  createUnattendedConfirmation,
  mayUnattendedTierApproveBrowser,
} from '../permissions/unattendedConfirmation';
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

export interface TriggerCallbackOptions {
  authorizationScopeId: string;
}

type RuntimeTriggerPermissions = Omit<TriggerPermissions, 'allowedCommands' | 'allowedPaths' | 'allowedTools'> & {
  allowedCommands?: unknown;
  allowedPaths?: unknown;
  allowedTools?: unknown;
};

function getRuntimePermissions(action: TriggerAction): RuntimeTriggerPermissions | undefined {
  return (action as TriggerAction & { permissions?: RuntimeTriggerPermissions }).permissions;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : [];
}

/**
 * Resolve permission callbacks for a trigger based on its capability level.
 * Pre-authorizes workspace and allowed paths before execution.
 */
export function resolveTriggerCallbacks(action: TriggerAction, options: TriggerCallbackOptions): TriggerCallbacks {
  const capability = normalizeTriggerRunCapability((action as TriggerAction & { capability?: unknown }).capability);
  const permissions = getRuntimePermissions(action);
  const authorizationScopeId = options.authorizationScopeId;

  // Pre-authorize the workspace path with the rights the tier actually
  // promises — NOT authorizeWorkspace's read+write default. An authorized
  // workspace short-circuits `checkWritePath` inside registry.ts *before*
  // `filePermissionCallback` is ever consulted, so a blanket read+write grant
  // here silently overrides the read-only callback below: a 'read_tools'
  // trigger ("reads information, changes nothing") could write anywhere
  // inside its own workspace. b4ce62e8 closed exactly this hole on the
  // scheduler side and its own commit note flagged the trigger path as still
  // open; this closes it. The grant is scoped to this unattended run, so a
  // standing global read+write grant from an interactive session is not
  // inherited by read_tools.
  if (action.workspacePath) {
    scopedAuthorizeWorkspace(
      authorizationScopeId,
      action.workspacePath,
      capability === 'read_tools' ? ['read'] : ['read', 'write'],
    );
  }

  // Pre-authorize custom allowed paths
  if (capability === 'custom') {
    for (const p of getStringArray(permissions?.allowedPaths)) {
      scopedAuthorizeWorkspace(authorizationScopeId, p);
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
        commandConfirmCallback: createUnattendedConfirmation({
          source: 'trigger',
          onDenied: (reason, info) => {
            console.log(`[Trigger] read_tools: denied "${info.command}" (${reason})`);
          },
        }),
        filePermissionCallback: async (req) => {
          // The run's declared workspace was already pre-authorized above.
          // Reaching this callback means the path is outside that run-local
          // set, so a standing interactive grant must not bridge into it.
          console.log(`[Trigger] read_tools: denied ${req.capability} "${req.path}"`);
          return false;
        },
        blockedTools,
        allowedTools: getReadOnlyRunToolAllowlist(),
      };

    case 'safe_tools':
      return {
        commandConfirmCallback: createUnattendedConfirmation({
          source: 'trigger',
          onDenied: (reason, info) => {
            console.log(`[Trigger] safe_tools: denied "${info.command}" (${reason})`);
          },
        }),
        filePermissionCallback: async (req) => {
          // Workspace access is already present in this run's scope. Never
          // import unrelated interactive grants into an unattended run.
          console.log(`[Trigger] safe_tools: denied ${req.capability} "${req.path}"`);
          return false;
        },
        blockedTools,
        allowedTools: getSafeRunToolAllowlist(),
      };

    case 'full':
      return {
        commandConfirmCallback: async (info) => {
          // A capability tier is a CEILING — it may only remove authority. The
          // browser operation-class policy is therefore evaluated independently
          // of the tier: `full` must not be able to auto-approve page scripting
          // in a run nobody is watching (the same hole `authGate.ts`'s `full`
          // tier carried; `registry.ts` closes it at the gate, this closes it
          // at the tier so a future refactor cannot reopen it).
          if (info.kind === 'browser' && !mayUnattendedTierApproveBrowser(info)) {
            console.log(`[Trigger] full: browser action "${info.command}" denied by the unattended browser policy`);
            return false;
          }
          // Allow everything except hard-blocked commands
          const allowed = info.level !== 'block';
          if (!allowed) {
            console.log(`[Trigger] full: blocked command "${info.command}" (${info.reason})`);
          }
          return allowed;
        },
        filePermissionCallback: async (req) => {
          // Auto-allow all file access (pathSafety hard blocks still apply in executeAnyTool)
          scopedAuthorizeWorkspace(authorizationScopeId, req.path);
          return true;
        },
        blockedTools,
      };

    case 'custom':
      return buildCustomCallbacks(permissions, blockedTools);
  }
}

function buildCustomCallbacks(
  permissions: RuntimeTriggerPermissions | undefined,
  blockedTools: string[],
): TriggerCallbacks {
  const allowedCommands = normalizeCustomRunCommandAllowlist(permissions?.allowedCommands);

  return {
    commandConfirmCallback: async (info) => {
      if (info.level === 'block') return false;
      // See the `full` tier: allowedCommands is a COMMAND allowlist and says
      // nothing about browser operations, so a browser confirmation reaching
      // here is decided by the operation-class policy, never by a glob.
      if (info.kind === 'browser') return mayUnattendedTierApproveBrowser(info);
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
      // Explicit allowedPaths were pre-authorized in the run scope. A path
      // that still reaches this callback is outside that allowlist, even if
      // an interactive conversation granted it globally.
      console.log(`[Trigger] custom: denied ${req.capability} "${req.path}"`);
      return false;
    },
    blockedTools,
    allowedTools: normalizeCustomRunToolAllowlist(permissions?.allowedTools),
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
