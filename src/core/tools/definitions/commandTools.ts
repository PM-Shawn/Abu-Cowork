import type { ToolDefinition } from '../../../types';
import { getPlatform, getShell, isWindows } from '../../../utils/platform';
import { resolveCommandPython } from '../../../utils/pythonRuntime';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { getWorkspaceReader } from '../../agent/ports/workspaceReader';
import { getAuthorizedPathsReader } from '../../agent/ports/authorizedPathsReader';
import { showSandboxBlockedToast } from '../../sandbox/recovery';
import {
  detectAppAutomationSandboxBlock,
  getAppAutomationSandboxRecovery,
  hasUnquotedShellControlSyntax,
} from '../../sandbox/appAutomationRecovery';
import type { CommandOutput } from '../helpers/toolHelpers';
import { invokeTaskCommand, isTaskCommandAbortedError } from '../helpers/scopedCommand';
import { isReadOnlyCommand } from '../readOnlyDetector';
import { TOOL_NAMES } from '../toolNames';
import { format, getI18n } from '../../../i18n';
import { hasElectronCommandHost } from '../../../utils/electronHost';

/**
 * Global-workspace fallback for direct invocations that carry no context.
 * Sidecar-safe: the bare `getWorkspaceReader()` getter throws outside a
 * registered agent run (see `shims/workspaceReaderRun.ts`) — a throwing
 * fallback must degrade to "no workspace", never fail the command itself.
 */
function safeGlobalWorkspacePath(): string | null {
  try {
    return getWorkspaceReader().getCurrentPath();
  } catch {
    return null;
  }
}

function formatAppAutomationRecovery(
  recovery: NonNullable<ReturnType<typeof getAppAutomationSandboxRecovery>>,
): string {
  const app = recovery.targetApp
    ?? getI18n().sandbox.appAutomationTargetFallback;
  return [
    format(getI18n().sandbox.appAutomationToolError, { app }),
  ].join('\n\n');
}

export const runCommandTool: ToolDefinition = {
  name: TOOL_NAMES.RUN_COMMAND,
  get description() {
    const plat = getPlatform();
    const shell = getShell();
    return `Execute a shell command on the user's computer (current platform: ${plat}, shell: ${shell}).

Important: prefer a dedicated tool when one is available:
- Read a file → read_file
- List a directory → list_directory
- Search file contents → search_files
- Find files → find_files
- HTTP requests → http_fetch
- Edit a file → edit_file

This tool is suitable for: moving/copying/renaming files (mv/cp), package management (npm/pip/brew), build and test (npm run/cargo build), Git operations, running Python scripts (automatically uses the built-in runtime). Set background=true for long-running services.`;
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory for the command (optional, defaults to user home)' },
      background: { type: 'boolean', description: 'Set to true for long-running services (servers, etc). Will start the process and return initial output after a few seconds.' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 300). Command will be killed if it exceeds this.' },
    },
    required: ['command'],
  },
  execute: async (input, context) => {
    const command = input.command as string;
    const cwd = input.cwd as string | undefined;
    const background = input.background as boolean | undefined;
    const timeout = input.timeout as number | undefined;
    const abortSignal = context?.abortSignal;
    if (abortSignal?.aborted) {
      return 'Error executing command: command was aborted before it started';
    }

    try {
      // Use embedded Python runtime if command starts with python/python3
      const resolvedCommand = await resolveCommandPython(command);
      if (abortSignal?.aborted) {
        return 'Error executing command: command was aborted before it started';
      }

      // Exempt app-launcher commands from sandbox
      // macOS: `open` uses LaunchServices via XPC, blocked by Seatbelt
      // Windows: `start`/`Start-Process` exempted for consistency with ExecutionPolicy
      const isLauncherCandidate = isWindows()
        ? /^\s*(start|Start-Process)\s/i.test(resolvedCommand)
        : /^\s*open\s/.test(resolvedCommand);
      const isLauncherCmd = isLauncherCandidate
        && (
          !hasElectronCommandHost()
          || !hasUnquotedShellControlSyntax(resolvedCommand)
        );
      const sandbox = isLauncherCmd ? false : isSandboxEnabled();

      // Seatbelt does not contain the target app process: Apple Events can ask
      // that app to mutate data outside the shell profile. Electron therefore
      // blocks explicit cross-app AppleScript before spawn while Shell sandbox
      // protection is enabled. Tauri stays unchanged during coexistence.
      const preflightAppAutomationRecovery = sandbox && hasElectronCommandHost()
        ? getAppAutomationSandboxRecovery(resolvedCommand)
        : null;
      if (preflightAppAutomationRecovery) {
        context?.reportMetadata?.({
          sandboxRecovery: preflightAppAutomationRecovery,
        });
        return formatAppAutomationRecovery(preflightAppAutomationRecovery);
      }

      // Use the shell/session-owned workspace from context. Scoped unattended
      // runs fail closed when that trusted value is null/absent; only
      // unscoped interactive/direct invocations may fall back to the global
      // workspace reader.
      // The fallback must not fail the command: in the sidecar the bare getter
      // resolves an ambient-run mirror and THROWS outside a registered run —
      // treat that as "no workspace" (cwd-less spawn), matching the shell's
      // no-workspace behavior instead of erroring before the spawn.
      const workspacePath = context?.authorizationScopeId !== undefined
        ? (context.workspacePath ?? null)
        : (context?.workspacePath ?? safeGlobalWorkspacePath());
      const authorizedPaths = sandbox
        ? await getAuthorizedPathsReader().getAuthorizedWritablePaths(context?.authorizationScopeId)
        : [];
      const extraWritablePaths = [
        ...(context?.authorizationScopeId === undefined && workspacePath ? [workspacePath] : []),
        ...authorizedPaths,
      ];

      // Use custom Tauri command defined in Rust
      const output = await invokeTaskCommand<CommandOutput>('run_shell_command', {
        command: resolvedCommand,
        cwd: cwd || workspacePath || null,
        background: background || false,
        timeout: Math.min(Math.max(1, timeout ?? 30), 300),
        sandboxEnabled: sandbox,
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths,
      }, context, {
        commandIdPrefix: 'run-command',
        keepAbortListenerAfterResolve: (result) => background === true && result.code === 0,
      });

      const appAutomationRecovery = sandbox
        ? detectAppAutomationSandboxBlock(resolvedCommand, output.stderr, output.code)
        : null;
      if (appAutomationRecovery) {
        context?.reportMetadata?.({
          sandboxRecovery: appAutomationRecovery,
        });
      }

      // File/path blocks keep the existing toast. AppleScript cross-app
      // blocks render a task-local recovery card instead of a misleading
      // "authorize this directory" prompt.
      if (!appAutomationRecovery && sandbox && output.stderr.includes('[sandbox-blocked]')) {
        showSandboxBlockedToast(resolvedCommand);
      }

      const parts: string[] = [];
      if (appAutomationRecovery) {
        parts.push(formatAppAutomationRecovery(appAutomationRecovery));
      }
      if (output.stdout.trim()) {
        parts.push(`stdout:\n${output.stdout.trim()}`);
      }
      if (output.stderr.trim()) {
        parts.push(`stderr:\n${output.stderr.trim()}`);
      }
      parts.push(`exit code: ${output.code}`);

      return parts.join('\n\n');
    } catch (err) {
      if (isTaskCommandAbortedError(err)) {
        return 'Error executing command: command was aborted before it started';
      }
      return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: (input) => isReadOnlyCommand(String(input.command ?? '')),
};
