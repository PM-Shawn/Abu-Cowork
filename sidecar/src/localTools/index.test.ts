/**
 * Tests for the sidecar local tool registry (P1-3d-1, extended P1-3d-4 for
 * the read-path file tools). Runs against the REAL show_widget/read_me/
 * http_fetch/web_search/read_file/list_directory/search_files/find_files
 * implementations (not mocked) — this is the contract `agentLoopHost.test.ts`'s
 * "local tool dispatch" describe block assumes when it mocks THIS module to
 * test only the dispatcher's branch/fallback wiring in isolation.
 *
 * The four P1-3d-4 tools go through `fsBridge.ts` (readTextFile/readDir/
 * exists/stat) and `@tauri-apps/api/core`'s `invoke` (search_files/find_files'
 * `run_shell_command`) — both globally mocked by `src/test/setup.ts` (sidecar
 * status defaults to not-running, so `fsBridge.ts` falls through to the
 * mocked `@tauri-apps/plugin-fs` functions directly — same mocking seam
 * `fileTools.test.ts` itself relies on).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readDir, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { hasLocalTool, isLocalToolReadOnly, executeLocalTool } from './index';

const REGISTERED_TOOL_NAMES = [
  'show_widget',
  'read_me',
  'http_fetch',
  'web_search',
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
];

describe('localTools registry membership', () => {
  it.each(REGISTERED_TOOL_NAMES)('hasLocalTool("%s") is true', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it('hasLocalTool is false for an unregistered/unknown name', () => {
    expect(hasLocalTool('write_file')).toBe(false);
    expect(hasLocalTool('nonexistent_tool')).toBe(false);
  });

  it.each(REGISTERED_TOOL_NAMES)('isLocalToolReadOnly("%s") is true (Tier A — safe to fall back on failure)', (name) => {
    expect(isLocalToolReadOnly(name)).toBe(true);
  });

  it('isLocalToolReadOnly is false (fail-closed) for an unregistered name', () => {
    expect(isLocalToolReadOnly('nonexistent_tool')).toBe(false);
  });
});

describe('executeLocalTool — show_widget', () => {
  it('runs locally and returns the success marker for valid input', async () => {
    const result = await executeLocalTool(
      'show_widget',
      { title: 'Sales chart', widget_code: '<div>hi</div>', loading_messages: ['Rendering…'] },
      undefined,
      undefined,
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Sales chart');
  });

  it('catches the tool\'s own thrown validation error and returns it as an error STRING (never throws) — matches registry.ts:ToolRegistry.execute\'s contract', async () => {
    const result = await executeLocalTool(
      'show_widget',
      { title: '', widget_code: '<div>hi</div>', loading_messages: ['x'] },
      undefined,
      undefined,
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Error executing tool "show_widget"');
  });

  it('rejects a call missing a required field BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('show_widget', { widget_code: '<div>hi</div>' }, undefined, undefined);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('missing required parameter');
    expect(result as string).toContain('title');
  });
});

describe('executeLocalTool — read_me', () => {
  it('returns the widget guidelines text for a valid (empty) input', async () => {
    const result = await executeLocalTool('read_me', {}, undefined, undefined);
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });
});

describe('executeLocalTool — http_fetch', () => {
  it('runs the tool\'s pre-flight guard locally with no network call (URL too long)', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2100);
    const result = await executeLocalTool('http_fetch', { url: longUrl }, undefined, undefined);
    expect(result).toContain('URL too long');
  });

  it('rejects a call missing the required url field', async () => {
    const result = await executeLocalTool('http_fetch', {}, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(result as string).toContain('url');
  });
});

describe('executeLocalTool — fail-closed on an unregistered tool name', () => {
  it('throws (dispatch-layer bug signal) rather than silently no-op-ing — caller must check hasLocalTool() first', async () => {
    await expect(executeLocalTool('not_a_real_tool', {}, undefined, undefined)).rejects.toThrow(
      /unregistered tool/,
    );
  });
});

// ── P1-3d-4: read-path file tools ──────────────────────────────────────────

describe('executeLocalTool — list_directory', () => {
  beforeEach(() => {
    vi.mocked(readDir).mockReset();
  });

  it('runs locally and lists entries via the mocked fsBridge->plugin-fs fallback', async () => {
    vi.mocked(readDir).mockResolvedValueOnce([
      { name: 'b.txt', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'a-dir', isDirectory: true, isFile: false, isSymlink: false },
    ]);
    const result = await executeLocalTool('list_directory', { path: '/tmp/x' }, undefined, undefined);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('a-dir');
    expect(result as string).toContain('b.txt');
  });

  it('catches a real fs error and returns it as an error STRING (never throws)', async () => {
    vi.mocked(readDir).mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
    const result = await executeLocalTool('list_directory', { path: '/tmp/missing' }, undefined, undefined);
    expect(result as string).toContain('Error listing directory');
  });
});

describe('executeLocalTool — read_file (text)', () => {
  beforeEach(() => {
    vi.mocked(readTextFile).mockReset();
    vi.mocked(stat).mockReset();
  });

  it('runs locally and returns file content for a plain text file', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 5 } as unknown as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readTextFile).mockResolvedValueOnce('hello');
    const result = await executeLocalTool('read_file', { path: '/tmp/x.txt' }, undefined, undefined);
    expect(result).toBe('hello');
  });
});

describe('executeLocalTool — read_file PDF/PPTX/archive escalation (P1-3d-4)', () => {
  beforeEach(() => {
    vi.mocked(readTextFile).mockReset();
    vi.mocked(stat).mockReset();
  });

  it.each([
    ['a .pdf path', '/tmp/report.pdf'],
    ['a .pptx path', '/tmp/deck.pptx'],
    ['a non-Windows .zip path', '/tmp/archive.zip'],
    ['a .tar.gz path', '/tmp/archive.tar.gz'],
    ['a .tgz path', '/tmp/archive.tgz'],
  ])('THROWS (never returns a misleading string) for %s — escalates to the reverse tool.invoke path', async (_label, path) => {
    // No fsBridge/plugin-fs mock configured to return anything usable — if
    // the escalation pre-check didn't fire BEFORE calling the real tool,
    // this would fall through to whatever the default mock returns instead
    // of throwing, silently masking the bug this test guards against.
    await expect(executeLocalTool('read_file', { path }, undefined, undefined)).rejects.toThrow(
      /run_argv_command/,
    );
    // Confirms the escalation happens BEFORE any fs work — the real tool's
    // execute() body was never reached for these extensions.
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('does NOT escalate a .7z path — listArchiveContents has no run_argv_command branch for it, so it returns its normal "not supported" string locally (identical to what the reverse/shell path would return, no invoke call either way)', async () => {
    const result = await executeLocalTool('read_file', { path: '/tmp/archive.7z' }, undefined, undefined);
    expect(result).toBe('Archive listing not supported for .7z. Use run_command to extract.');
    // No escalation happened (this returned normally, not via a throw), and
    // no fs read was needed either — confirms the .7z branch never reaches
    // run_argv_command, so pre-flight escalation correctly leaves it alone.
    expect(readTextFile).not.toHaveBeenCalled();
  });
});

describe('executeLocalTool — search_files / find_files', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('search_files runs locally via the mocked native invoke("run_shell_command")', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '/tmp/x/a.ts:1:match\n', stderr: '' });
    const result = await executeLocalTool('search_files', { pattern: 'match', path: '/tmp/x' }, undefined, undefined);
    expect(result as string).toContain('a.ts');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({ command: expect.stringContaining('grep') }));
  });

  it('find_files runs locally via the mocked native invoke("run_shell_command")', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '/tmp/x/a.ts\n', stderr: '' });
    const result = await executeLocalTool('find_files', { pattern: '*.ts', path: '/tmp/x' }, undefined, undefined);
    expect(result as string).toContain('a.ts');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({ command: expect.stringContaining('find') }));
  });
});
