/**
 * Tests for the sidecar local tool registry (P1-3d-1, extended P1-3d-4 for
 * the read-path file tools, extended P1-3d A-write for write_file/edit_file).
 * Runs against the REAL show_widget/read_me/http_fetch/web_search/read_file/
 * list_directory/search_files/find_files/write_file/edit_file implementations
 * (not mocked) — this is the contract `agentLoopHost.test.ts`'s "local tool
 * dispatch" describe block assumes when it mocks THIS module to test only
 * the dispatcher's branch/fallback wiring in isolation.
 *
 * The four P1-3d-4 read tools (plus write_file/edit_file, P1-3d A-write) go
 * through `fsBridge.ts` (readTextFile/readDir/writeTextFile/exists/stat) and
 * `@tauri-apps/api/core`'s `invoke` (search_files/find_files' `run_shell_command`)
 * — both globally mocked by `src/test/setup.ts` (sidecar status defaults to
 * not-running, so `fsBridge.ts` falls through to the mocked
 * `@tauri-apps/plugin-fs` functions directly — same mocking seam
 * `fileTools.test.ts` itself relies on).
 *
 * `@/utils/aiEditSnapshots` is mocked wholesale (same as `fileTools.test.ts`)
 * — this file's `write_file`/`edit_file` tests exercise the REAL tool's
 * local-write behavior, not the P1-3d A-write reverse-RPC snapshot shim
 * (that's `sidecar/src/shims/aiEditSnapshotsRun.test.ts`'s job, in isolation
 * — see that file's doc for why: outside `npm run build:sidecar`'s esbuild
 * module-redirect, `fileTools.ts`'s static import of `snapshotBeforeAiEdit`
 * resolves to the REAL shell-side module under vitest, never the shim).
 * `bindWorkspaceFromWrite` (`@/core/agent/defaultWorkspace`) is left
 * UNMOCKED, same as `fileTools.test.ts` — its real implementation no-ops
 * immediately when `context.conversationId` is undefined (the shape these
 * tests use), so no store mocking is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readDir, readTextFile, writeTextFile, exists, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { hasLocalTool, isLocalToolReadOnly, executeLocalTool } from './index';

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/utils/aiEditSnapshots', () => ({
  snapshotBeforeAiEdit: (...args: unknown[]) => snapshotBeforeAiEditMock(...args),
}));

const READ_ONLY_TOOL_NAMES = [
  'show_widget',
  'read_me',
  'http_fetch',
  'web_search',
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
];

const WRITE_TOOL_NAMES = ['write_file', 'edit_file'];

describe('localTools registry membership', () => {
  it.each(READ_ONLY_TOOL_NAMES)('hasLocalTool("%s") is true', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it.each(WRITE_TOOL_NAMES)('hasLocalTool("%s") is true (P1-3d A-write)', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it('hasLocalTool is false for an unregistered/unknown name', () => {
    expect(hasLocalTool('delete_file')).toBe(false);
    expect(hasLocalTool('nonexistent_tool')).toBe(false);
  });

  it.each(READ_ONLY_TOOL_NAMES)('isLocalToolReadOnly("%s") is true (Tier A — safe to fall back on failure)', (name) => {
    expect(isLocalToolReadOnly(name)).toBe(true);
  });

  // 🔴 SECURITY-RELEVANT: write_file/edit_file are the first side-effecting
  // tools in this registry — readOnly:false means `agentLoopHost.ts`'s
  // caller RE-THROWS a local dispatch-layer failure instead of falling back
  // to the reverse tool.invoke path (no double-write risk). See
  // `LocalToolEntry.readOnly`'s doc and this module's "P1-3d A-write" doc
  // section.
  it.each(WRITE_TOOL_NAMES)('isLocalToolReadOnly("%s") is FALSE (side-effecting — never safe to retry after a local dispatch failure)', (name) => {
    expect(isLocalToolReadOnly(name)).toBe(false);
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

// ── P1-3d A-write: write-path file tools ────────────────────────────────────

describe('executeLocalTool — write_file (P1-3d A-write)', () => {
  beforeEach(() => {
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
    snapshotBeforeAiEditMock.mockClear();
  });

  it('runs locally: writes via the mocked fsBridge->plugin-fs fallback and returns the success marker', async () => {
    const result = await executeLocalTool('write_file', { path: '/tmp/x/out.txt', content: 'hello world' }, undefined, undefined);
    expect(result).toBe('Successfully wrote 11 characters to /tmp/x/out.txt');
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/x/out.txt', 'hello world');
  });

  it('calls the REAL snapshotBeforeAiEdit (mocked here) before writing — pre-edit snapshot semantics unchanged locally', async () => {
    await executeLocalTool('write_file', { path: '/tmp/x/out.txt', content: 'hi' }, { conversationId: 'conv-1', loopId: 'loop-1' }, undefined);
    expect(snapshotBeforeAiEditMock).toHaveBeenCalledWith('/tmp/x/out.txt', { loopId: 'loop-1', conversationId: 'conv-1' });
    // snapshot happens BEFORE the write — assert call order via mock invocation timestamps is
    // brittle, so instead assert both were called (temporal order is exercised end-to-end by
    // fileTools.test.ts's own write_file suite; this test's job is just "still wired through
    // the local dispatch path", not re-proving fileTools.ts's own internal ordering).
    expect(writeTextFile).toHaveBeenCalled();
  });

  it('catches a real fs error and returns it as an error STRING (never throws) — matches the readOnly:false dispatch-layer/tool-level distinction', async () => {
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const result = await executeLocalTool('write_file', { path: '/tmp/x/out.txt', content: 'hi' }, undefined, undefined);
    expect(result as string).toContain('Error writing file');
    expect(result as string).toContain('EACCES');
  });

  it('rejects a binary extension locally with the same guard the reverse path uses (no fsBridge call at all)', async () => {
    const result = await executeLocalTool('write_file', { path: '/tmp/x/out.docx', content: 'hi' }, undefined, undefined);
    expect(result as string).toContain('write_file only writes plain text');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('rejects a call missing required fields BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('write_file', { path: '/tmp/x/out.txt' }, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(result as string).toContain('content');
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe('executeLocalTool — edit_file (P1-3d A-write)', () => {
  beforeEach(() => {
    vi.mocked(exists).mockReset().mockResolvedValue(true);
    vi.mocked(readTextFile).mockReset();
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
    snapshotBeforeAiEditMock.mockClear();
  });

  it('runs locally: reads, replaces, writes via the mocked fsBridge->plugin-fs fallback', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('const x = 1;\nconst y = 2;\n');
    const result = await executeLocalTool(
      'edit_file',
      { path: '/tmp/x/a.ts', old_content: 'const x = 1;', new_content: 'const x = 100;' },
      undefined,
      undefined,
    );
    expect(result as string).toContain('Successfully edited');
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/x/a.ts', 'const x = 100;\nconst y = 2;\n');
  });

  it('returns an error STRING (never throws) when the file does not exist', async () => {
    vi.mocked(exists).mockResolvedValueOnce(false);
    const result = await executeLocalTool('edit_file', { path: '/tmp/x/missing.ts', old_content: 'a', new_content: 'b' }, undefined, undefined);
    expect(result as string).toContain('File not found');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('returns an error STRING (never throws) when old_content does not match uniquely', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('no match here');
    const result = await executeLocalTool('edit_file', { path: '/tmp/x/a.ts', old_content: 'nope', new_content: 'b' }, undefined, undefined);
    expect(result as string).toContain('old_content not found');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('rejects a call missing required fields BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('edit_file', { path: '/tmp/x/a.ts' }, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(exists).not.toHaveBeenCalled();
  });
});
