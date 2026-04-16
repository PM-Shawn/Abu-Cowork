import type { IPCAdapter } from '../ports/adapters/ipc';
import { parseArgs } from '../common/argsParser';

export { parseArgs };

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 对比 Abu 原版改动：
 * - `substituteVariables` 纯函数，原样保留；
 * - `executeInlineCommands` 原本 `invoke('run_shell_command', ...)` →
 *   改为 IPCAdapter.invoke('run_shell_command', ...)，Node 端若无 IPC 则优雅降级为错误消息。
 */

export function substituteVariables(
  content: string,
  args: string,
  skillDir: string,
  sessionId: string
): string {
  const positionalArgs = parseArgs(args);
  const hasArgsPlaceholder = content.includes('$ARGUMENTS');

  let result = content;
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => positionalArgs[+i] ?? '');
  result = result.replace(/\$(\d+)(?!\w)/g, (_, i) => positionalArgs[+i] ?? '');
  result = result.replace(/\$ARGUMENTS/g, args);
  result = result.replace(/\$\{ABU_SESSION_ID\}/g, sessionId);
  result = result.replace(/\$\{ABU_SKILL_DIR\}/g, skillDir);
  result = result.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId);
  result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir);

  if (args && !hasArgsPlaceholder) {
    result += `\nARGUMENTS: ${args}`;
  }
  return result;
}

export async function executeInlineCommands(
  content: string,
  skillDir: string,
  ipc?: IPCAdapter
): Promise<string> {
  const pattern = /!`([^`]+)`/g;
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) return content;

  if (!ipc || !ipc.available('run_shell_command')) {
    // Graceful degrade: replace with hint when shell execution not available
    let result = content;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const start = m.index!;
      const end = start + m[0].length;
      result =
        result.substring(0, start) +
        `[Inline command not executed: IPC shell not available in this runtime]` +
        result.substring(end);
    }
    return result;
  }

  const results = await Promise.allSettled(
    matches.map(async (match) => {
      const command = match[1];
      try {
        const output = await ipc.invoke<CommandOutput>('run_shell_command', {
          command,
          cwd: skillDir,
          background: false,
          timeout: 10,
          sandbox: true,
          extra_writable_paths: [skillDir],
        });
        return output.code === 0
          ? output.stdout.trim()
          : `[Command failed: ${output.stderr.trim()}]`;
      } catch (err) {
        return `[Command error: ${err instanceof Error ? err.message : String(err)}]`;
      }
    })
  );

  let result = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const start = match.index!;
    const end = start + match[0].length;
    const settled = results[i];
    const replacement =
      settled.status === 'fulfilled' ? settled.value : `[Command error: ${settled.reason}]`;
    result = result.substring(0, start) + replacement + result.substring(end);
  }
  return result;
}
