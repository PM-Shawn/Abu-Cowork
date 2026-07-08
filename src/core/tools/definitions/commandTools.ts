import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition } from '../../../types';
import { getPlatform, getShell, isWindows } from '../../../utils/platform';
import { resolveCommandPython } from '../../../utils/pythonRuntime';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { getAuthorizedWritablePaths } from '../pathSafety';
import { showSandboxBlockedToast } from '../../sandbox/recovery';
import type { CommandOutput } from '../helpers/toolHelpers';
import { isReadOnlyCommand } from '../readOnlyDetector';
import { TOOL_NAMES } from '../toolNames';

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

    try {
      // Use embedded Python runtime if command starts with python/python3
      const resolvedCommand = await resolveCommandPython(command);

      // Exempt app-launcher commands from sandbox
      // macOS: `open` uses LaunchServices via XPC, blocked by Seatbelt
      // Windows: `start`/`Start-Process` exempted for consistency with ExecutionPolicy
      const isLauncherCmd = isWindows()
        ? /^\s*(start|Start-Process)\s/i.test(resolvedCommand)
        : /^\s*open\s/.test(resolvedCommand);
      const sandbox = isLauncherCmd ? false : isSandboxEnabled();

      // Use conversation-scoped workspace from context; fall back to global store
      // only if context is absent (e.g. direct invocation outside agent loop).
      const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
      const authorizedPaths = sandbox ? getAuthorizedWritablePaths() : [];
      const extraWritablePaths = [
        ...(workspacePath ? [workspacePath] : []),
        ...authorizedPaths,
      ];

      // Use custom Tauri command defined in Rust
      const output = await invoke<CommandOutput>('run_shell_command', {
        command: resolvedCommand,
        cwd: cwd || workspacePath || null,
        background: background || false,
        timeout: Math.min(Math.max(1, timeout ?? 30), 300),
        sandboxEnabled: sandbox,
        networkIsolation: isNetworkIsolationEnabled(),
        extraWritablePaths,
      });

      // Detect sandbox-blocked errors and show recovery toast
      if (sandbox && output.stderr.includes('[sandbox-blocked]')) {
        showSandboxBlockedToast(resolvedCommand);
      }

      const parts: string[] = [];
      if (output.stdout.trim()) {
        parts.push(`stdout:\n${output.stdout.trim()}`);
      }
      if (output.stderr.trim()) {
        parts.push(`stderr:\n${output.stderr.trim()}`);
      }
      parts.push(`exit code: ${output.code}`);

      return parts.join('\n\n');
    } catch (err) {
      return `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: (input) => isReadOnlyCommand(String(input.command ?? '')),
};
