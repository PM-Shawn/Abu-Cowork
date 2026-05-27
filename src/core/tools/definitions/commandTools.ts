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
    return `在用户电脑上执行 shell 命令（当前平台：${plat}，Shell：${shell}）。

重要：当有专用工具时优先使用专用工具：
- 读取文件 → read_file
- 查看目录 → list_directory
- 搜索文件内容 → search_files
- 查找文件 → find_files
- HTTP 请求 → http_fetch
- 编辑文件 → edit_file

本工具适用于：文件移动/复制/重命名（mv/cp）、包管理（npm/pip/brew）、构建测试（npm run/cargo build）、Git 操作、Python 脚本执行（自动使用内置运行时）。长时间运行的服务设置 background=true。`;
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
  execute: async (input) => {
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

      // Allow writes to workspace + user-authorized directories under sandbox
      const workspacePath = useWorkspaceStore.getState().currentPath;
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
