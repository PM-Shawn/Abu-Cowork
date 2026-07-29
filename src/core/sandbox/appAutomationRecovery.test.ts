import { describe, expect, it } from 'vitest';
import {
  detectAppAutomationSandboxBlock,
  extractAppleScriptTargetApp,
  getAppAutomationSandboxRecovery,
  hasUnquotedShellControlSyntax,
  isAppleScriptCommand,
} from './appAutomationRecovery';

describe('appAutomationRecovery', () => {
  it('detects an AppleScript app automation block and extracts the target app', () => {
    const recovery = detectAppAutomationSandboxBlock(
      `osascript -e 'tell application "Notes" to make new note'`,
      '[sandbox-blocked] deny file-issue-extension',
      1,
    );

    expect(recovery).toEqual({
      kind: 'app-automation',
      targetApp: 'Notes',
    });
  });

  it('recognizes the raw macOS Seatbelt signature without Abu marker text', () => {
    const recovery = detectAppAutomationSandboxBlock(
      `/usr/bin/osascript -e 'tell app "Calendar" to activate'`,
      'sandbox-exec: lsopen: Operation not permitted',
      1,
    );

    expect(recovery).toEqual({
      kind: 'app-automation',
      targetApp: 'Calendar',
    });
  });

  it('builds a preflight recovery only for explicit cross-app AppleScript', () => {
    expect(getAppAutomationSandboxRecovery(
      `osascript -e 'tell application "Notes" to make new note'`,
    )).toEqual({
      kind: 'app-automation',
      targetApp: 'Notes',
    });
    expect(getAppAutomationSandboxRecovery(
      `osascript -e 'return POSIX path of (path to home folder)'`,
    )).toEqual({
      kind: 'app-automation',
      targetApp: undefined,
    });
    expect(getAppAutomationSandboxRecovery('echo osascript')).toBeNull();
    expect(getAppAutomationSandboxRecovery('osascript /tmp/mutate.scpt')).toEqual({
      kind: 'app-automation',
      targetApp: undefined,
    });
  });

  it('extracts a JXA target app', () => {
    expect(
      extractAppleScriptTargetApp(`osascript -l JavaScript -e 'Application("Reminders").activate()'`),
    ).toBe('Reminders');
  });

  it('uses the controlled process instead of the System Events bridge as target', () => {
    expect(
      extractAppleScriptTargetApp(
        `osascript -e 'tell application "System Events" to tell process "Notes" to click button 1'`,
      ),
    ).toBe('Notes');
  });

  it('recognizes osascript only as a command token', () => {
    expect(isAppleScriptCommand('/usr/bin/osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand('env LANG=C osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand('env -i osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand('LANG=C osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand('command osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand('nohup /bin/osascript -e "return 1"')).toBe(true);
    expect(isAppleScriptCommand(`sh -c 'osascript -e "return 1"'`)).toBe(true);
    expect(isAppleScriptCommand(`sudo sh -c 'osascript -e "return 1"'`)).toBe(true);
    expect(isAppleScriptCommand(`arch -arm64 osascript -e "return 1"`)).toBe(true);
    expect(isAppleScriptCommand(`eval 'osascript -e "return 1"'`)).toBe(true);
    expect(isAppleScriptCommand(`env -S 'osascript -e "return 1"'`)).toBe(true);
    expect(isAppleScriptCommand('echo "$(osascript -e \\"return 1\\")"')).toBe(true);
    expect(isAppleScriptCommand('echo `osascript -e "return 1"`')).toBe(true);
    expect(isAppleScriptCommand(
      `python -c 'import subprocess; subprocess.run(["/usr/bin/osascript", "-e", "return 1"])'`,
    )).toBe(true);
    expect(isAppleScriptCommand('echo osascript')).toBe(false);
    expect(isAppleScriptCommand('cat my-osascript-log')).toBe(false);
  });

  it('recognizes a kernel-level osascript exec denial even when a wrapper hid the command token', () => {
    expect(
      detectAppAutomationSandboxBlock(
        'tool=/usr/bin/osascript; "$tool" /tmp/action.scpt',
        'zsh: operation not permitted: /usr/bin/osascript\n[sandbox-blocked]',
        126,
      ),
    ).toEqual({
      kind: 'app-automation',
      targetApp: undefined,
    });
  });

  it('does not classify successful, generic shell, or TCC-only failures', () => {
    expect(
      detectAppAutomationSandboxBlock(
        `osascript -e 'tell application "Notes" to activate'`,
        '[sandbox-blocked] deny file-issue-extension',
        0,
      ),
    ).toBeNull();
    expect(
      detectAppAutomationSandboxBlock(
        'cp a.txt /etc/a.txt',
        '[sandbox-blocked] deny file-write-create',
        1,
      ),
    ).toBeNull();
    expect(
      detectAppAutomationSandboxBlock(
        `osascript -e 'tell application "Notes" to activate'`,
        'Not authorized to send Apple events to Notes. (-1743)',
        1,
      ),
    ).toBeNull();
    expect(
      detectAppAutomationSandboxBlock(
        `osascript -e 'return POSIX file "/private/example"'`,
        'execution error: 文件许可错误。 (-54)',
        1,
      ),
    ).toBeNull();
    expect(
      detectAppAutomationSandboxBlock(
        `osascript -e 'tell application "Notes" to make new note'`,
        'execution error: 文件许可错误。 (-54)',
        1,
      ),
    ).toBeNull();
    expect(
      detectAppAutomationSandboxBlock(
        `osascript -e 'tell application "Notes" to activate'`,
        '“Notes”遇到一个错误：应用程序没有运行。 (-600)',
        1,
      ),
    ).toBeNull();
  });

  it('distinguishes pure launcher arguments from shell chaining and substitution', () => {
    expect(hasUnquotedShellControlSyntax('open -a "Notes"')).toBe(false);
    expect(hasUnquotedShellControlSyntax('open -a "App; Preview"')).toBe(false);
    expect(hasUnquotedShellControlSyntax('open -a Notes && osascript -e "return 1"')).toBe(true);
    expect(hasUnquotedShellControlSyntax('open -a Notes > /tmp/output')).toBe(true);
    expect(hasUnquotedShellControlSyntax('open -a "$(whoami)"')).toBe(true);
  });
});
