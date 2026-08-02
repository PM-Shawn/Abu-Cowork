import type { SandboxRecoveryPayload } from '@/types';

const APP_NAME_MAX_LENGTH = 80;

function cleanAppName(value: string): string | undefined {
  const cleaned = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, APP_NAME_MAX_LENGTH);
  return cleaned || undefined;
}

export function isAppleScriptCommand(command: string): boolean {
  // Absolute osascript paths embedded in another interpreter invocation
  // (for example Python subprocess) are still explicit app-automation intent.
  if (/(?:^|[^\w/.-])\/(?:usr\/)?bin\/osascript(?=$|[^\w.-])/i.test(command)) {
    return true;
  }

  const directInvocation =
    /(?:^|[\n;&|(`]|\$\()\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)|command|exec|xcrun|nohup|env(?:\s+-[^\s]+)*|nice(?:\s+-[^\s]+(?:\s+[^\s]+)?)?|sudo(?:\s+-[^\s]+(?:\s+[^\s]+)?)?|arch(?:\s+-[^\s]+)*)\s+)*(?:\/(?:usr\/)?bin\/)?osascript(?=\s|$|[;&|)`])/i;
  if (directInvocation.test(command)) return true;

  // A nested login shell is a common way for models and scripts to invoke
  // osascript. Inspect the literal -c payload recursively so quoting the
  // command does not bypass the preflight.
  const shellPayload =
    /(?:^|[\n;&|(`])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+|command|exec|nohup|env(?:\s+-[^\s]+)*|nice(?:\s+-[^\s]+(?:\s+[^\s]+)?)?|sudo(?:\s+-[^\s]+(?:\s+[^\s]+)?)?|arch(?:\s+-[^\s]+)*)\s+)*(?:\/(?:usr\/)?bin\/)?(?:ba|z|)sh\s+-[A-Za-z]*c[A-Za-z]*\s+(["'])([\s\S]*?)\1/gi;
  for (const match of command.matchAll(shellPayload)) {
    if (match[2] && isAppleScriptCommand(match[2])) return true;
  }

  const literalWrapperPayload =
    /(?:^|[\n;&|(`])\s*(?:command\s+)?(?:eval|env\s+(?:-S|--split-string))\s+(["'])([\s\S]*?)\1/gi;
  for (const match of command.matchAll(literalWrapperPayload)) {
    if (match[2] && isAppleScriptCommand(match[2])) return true;
  }

  for (const match of command.matchAll(/`([^`]*)`/g)) {
    if (match[1] && isAppleScriptCommand(match[1])) return true;
  }

  return false;
}

export function extractAppleScriptTargetApp(command: string): string | undefined {
  const processMatch = command.match(
    /\btell\s+(?:application\s+)?process\s+["']([^"']+)["']/i,
  );
  if (processMatch?.[1]) return cleanAppName(processMatch[1]);

  const tellMatch = command.match(/\btell\s+(?:application|app)\s+["']([^"']+)["']/i);
  if (tellMatch?.[1]) return cleanAppName(tellMatch[1]);

  const jxaMatch = command.match(/\bApplication\s*\(\s*["']([^"']+)["']\s*\)/i);
  if (jxaMatch?.[1]) return cleanAppName(jxaMatch[1]);

  return undefined;
}

export function getAppAutomationSandboxRecovery(
  command: string,
): SandboxRecoveryPayload | null {
  if (!isAppleScriptCommand(command)) return null;
  const targetApp = extractAppleScriptTargetApp(command);
  return {
    kind: 'app-automation',
    targetApp,
  };
}

/**
 * Electron may exempt a pure platform launcher from Seatbelt because
 * LaunchServices itself cannot run inside the profile. A launcher followed by
 * another shell operation must not inherit that exemption.
 */
export function hasUnquotedShellControlSyntax(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Command substitution remains active inside double quotes.
    if (!inSingleQuote && (ch === '`' || (ch === '$' && command[i + 1] === '('))) {
      return true;
    }
    if (!inSingleQuote && !inDoubleQuote && /[;&|<>\r\n]/.test(ch)) {
      return true;
    }
  }

  return false;
}

export function detectAppAutomationSandboxBlock(
  command: string,
  stderr: string,
  exitCode: number,
): SandboxRecoveryPayload | null {
  if (exitCode === 0) return null;

  const lower = stderr.toLowerCase();
  const hasAppleScriptEvidence =
    isAppleScriptCommand(command)
    || /(?:\/(?:usr\/)?bin\/)?osascript/.test(lower);
  if (!hasAppleScriptEvidence) return null;

  const targetApp = extractAppleScriptTargetApp(command);
  const hasSandboxEvidence =
    lower.includes('[sandbox-blocked]')
    || lower.includes('file-issue-extension')
    || (lower.includes('lsopen') && lower.includes('operation not permitted'))
    || (lower.includes('sandbox-exec') && lower.includes('operation not permitted'));

  if (!hasSandboxEvidence) return null;

  return {
    kind: 'app-automation',
    targetApp,
  };
}
