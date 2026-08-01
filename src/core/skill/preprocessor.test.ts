import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { substituteVariables, executeInlineCommands } from './preprocessor';
import { parseArgs } from '../../utils/argsParser';

function setElectronMarker(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  if (enabled) runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
  else delete runtime.__ABU_SHELL__;
}

describe('parseArgs', () => {
  it('parses space-separated args', () => {
    expect(parseArgs('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles quoted strings', () => {
    expect(parseArgs('"hello world" foo')).toEqual(['hello world', 'foo']);
    expect(parseArgs("'hello world' foo")).toEqual(['hello world', 'foo']);
  });

  it('returns empty array for empty string', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   ')).toEqual([]);
  });

  it('handles mixed quotes', () => {
    expect(parseArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });
});

describe('substituteVariables', () => {
  const skillDir = '/Users/test/.abu/skills/my-skill';
  const sessionId = 'sess-123';

  it('replaces $ARGUMENTS with full args string', () => {
    const result = substituteVariables('Task: $ARGUMENTS', 'hello world', skillDir, sessionId);
    expect(result).toBe('Task: hello world');
  });

  it('replaces $0, $1, etc. with positional args', () => {
    const result = substituteVariables('First: $0, Second: $1 ($ARGUMENTS)', 'foo bar', skillDir, sessionId);
    expect(result).toBe('First: foo, Second: bar (foo bar)');
  });

  it('replaces $ARGUMENTS[N] with positional args', () => {
    const result = substituteVariables('$ARGUMENTS[0] and $ARGUMENTS[1]', 'a b', skillDir, sessionId);
    expect(result).toBe('a and b');
  });

  it('replaces ${ABU_SKILL_DIR}', () => {
    const result = substituteVariables('Dir: ${ABU_SKILL_DIR}', '', skillDir, sessionId);
    expect(result).toBe(`Dir: ${skillDir}`);
  });

  it('replaces ${ABU_SESSION_ID}', () => {
    const result = substituteVariables('Session: ${ABU_SESSION_ID}', '', skillDir, sessionId);
    expect(result).toBe('Session: sess-123');
  });

  it('replaces ${CLAUDE_SKILL_DIR} and ${CLAUDE_SESSION_ID} (compat)', () => {
    const result = substituteVariables(
      '${CLAUDE_SKILL_DIR} ${CLAUDE_SESSION_ID}',
      '',
      skillDir,
      sessionId,
    );
    expect(result).toBe(`${skillDir} sess-123`);
  });

  it('auto-appends ARGUMENTS when not referenced in content', () => {
    const result = substituteVariables('Do something', 'my args', skillDir, sessionId);
    expect(result).toBe('Do something\nARGUMENTS: my args');
  });

  it('does not auto-append when $ARGUMENTS is in content', () => {
    const result = substituteVariables('Task: $ARGUMENTS', 'my args', skillDir, sessionId);
    expect(result).not.toContain('\nARGUMENTS:');
  });

  it('does not auto-append when args is empty', () => {
    const result = substituteVariables('Do something', '', skillDir, sessionId);
    expect(result).toBe('Do something');
  });

  it('handles missing positional args gracefully (auto-appends ARGUMENTS)', () => {
    const result = substituteVariables('$0 $1 $2', 'only', skillDir, sessionId);
    expect(result).toBe('only  \nARGUMENTS: only');
  });

  it('handles all substitutions together', () => {
    const content = 'Run $0 in ${ABU_SKILL_DIR} with args: $ARGUMENTS (session: ${ABU_SESSION_ID})';
    const result = substituteVariables(content, 'test --verbose', skillDir, sessionId);
    expect(result).toBe(`Run test in ${skillDir} with args: test --verbose (session: sess-123)`);
  });
});

describe('executeInlineCommands', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    setElectronMarker(false);
  });

  afterEach(() => {
    vi.mocked(invoke).mockReset();
    setElectronMarker(false);
  });

  it('keeps the locked Tauri payload and replaces an inline command with stdout', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: 'hello\n', stderr: '' });

    const result = await executeInlineCommands('Result: !`printf hello`', '/tmp/example-skill');

    expect(result).toBe('Result: hello');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', {
      command: 'printf hello',
      cwd: '/tmp/example-skill',
      background: false,
      timeout: 10,
      sandboxEnabled: true,
      extraWritablePaths: ['/tmp/example-skill'],
    });
  });

  it('routes task cancellation to abort_command for a running Electron inline command', async () => {
    setElectronMarker(true);
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return undefined;
    });

    const running = executeInlineCommands(
      'Before !`sleep 60` after',
      '/tmp/example-skill',
      { abortSignal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_shell_command',
        expect.objectContaining({
          command: 'sleep 60',
          commandId: expect.stringMatching(/^skill-inline-/),
        }),
      );
    });
    const commandCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_shell_command');
    const commandId = (commandCall?.[1] as { commandId: string }).commandId;

    controller.abort();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId });
    });
    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    await expect(running).resolves.toContain('[Command failed: [Command aborted]]');
  });
});
