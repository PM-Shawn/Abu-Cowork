/**
 * Tests for the sidecar local tool registry (P1-3d-1, extended P1-3d-4 for
 * the read-path file tools, extended P1-3d A-write for write_file/edit_file,
 * extended P1-3d-5 slice 1 for process_image, extended P1-3d-5 slice 2b for
 * run_command).
 * Runs against the REAL show_widget/read_me/http_fetch/web_search/read_file/
 * list_directory/search_files/find_files/write_file/edit_file/process_image/
 * run_command implementations (not mocked) — this is the contract
 * `agentLoopHost.test.ts`'s "local tool dispatch" describe block assumes when
 * it mocks THIS module to test only the dispatcher's branch/fallback wiring
 * in isolation.
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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readDir, readTextFile, writeTextFile, exists, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { hasLocalTool, isLocalToolReadOnly, executeLocalTool } from './index';

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/utils/aiEditSnapshots', () => ({
  snapshotBeforeAiEdit: (...args: unknown[]) => snapshotBeforeAiEditMock(...args),
}));

afterEach(() => {
  delete (globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  }).__ABU_SHELL__;
});

const READ_ONLY_TOOL_NAMES = [
  'show_widget',
  'read_me',
  'web_search',
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
];

const WRITE_TOOL_NAMES = ['write_file', 'edit_file', 'delete_file'];

// process_image (P1-3d-5 slice 1): side-effecting (writes output_path via a
// shell command), same readOnly:false discipline as WRITE_TOOL_NAMES, but no
// FILE_TOOL_PATH_MAP approval gate in the reverse path (see index.ts's
// "P1-3d-5 slice 1: process_image" doc section).
//
// run_command (TOOL_NAMES.RUN_COMMAND, P1-3d-5 slice 2b): side-effecting
// (spawns an arbitrary shell command), same readOnly:false discipline. Unlike
// process_image, it DOES have a tool-specific approval gate in the reverse
// path — the commandSafety check (`registry.ts:295`'s `name ===
// TOOL_NAMES.RUN_COMMAND` branch) — but that gate is applied entirely via the
// generic `approval.check` reverse RPC every local dispatch goes through
// BEFORE `agentLoopHost.ts` ever calls `executeLocalTool` (P1-3d-3's
// `checkLocalToolApproval` — tool-name-agnostic, already covered by
// `agentLoopHost.test.ts`'s "local tool dispatch (P1-3d-1 / P1-3d-3 approval
// gate)" describe block, which exercises that gate against ANY registered
// local tool, run_command included now that it's registered). THIS file
// tests only the registration/membership + the real local execute() below —
// see index.ts's "P1-3d-5 slice 2b: run_command" doc section for the full
// approval-parity trace.
const SIDE_EFFECTING_TOOL_NAMES = ['http_fetch', 'process_image', 'run_command'];

describe('localTools registry membership', () => {
  it.each(READ_ONLY_TOOL_NAMES)('hasLocalTool("%s") is true', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it.each(WRITE_TOOL_NAMES)('hasLocalTool("%s") is true (P1-3d A-write)', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it.each(SIDE_EFFECTING_TOOL_NAMES)('hasLocalTool("%s") is true (P1-3d-5 slice 1)', (name) => {
    expect(hasLocalTool(name)).toBe(true);
  });

  it('hasLocalTool is false for an unregistered/unknown name', () => {
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

  it.each(SIDE_EFFECTING_TOOL_NAMES)('isLocalToolReadOnly("%s") is FALSE (P1-3d-5 slice 1 — writes output_path, same discipline as write_file/edit_file)', (name) => {
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
    // Parity with the reverse executeAnyTool path: an OS-permission error on a
    // locally-executed file tool is wrapped with the same friendly grant-guide
    // (applyOSPermissionGuideIfNeeded), not returned as a raw EACCES string.
    // '系统未授权阿布访问此位置' is stable across the macOS/Windows guide branches.
    expect(result as string).toContain('系统未授权阿布访问此位置');
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

// ── P1-3d-5 slice 1: process_image ───────────────────────────────────────────

describe('executeLocalTool — process_image (P1-3d-5 slice 1)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('runs locally via the mocked native invoke("run_shell_command") and returns the success marker', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const result = await executeLocalTool(
      'process_image',
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'resize', width: 100, height: 100 },
      undefined,
      undefined,
    );
    expect(result).toBe('Image processed successfully: /tmp/out.png');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({ command: expect.stringContaining('sips') }));
  });

  it('catches a non-zero exit code and returns it as an error STRING (never throws)', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'sips: bad format' });
    const result = await executeLocalTool(
      'process_image',
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'convert', format: 'png' },
      undefined,
      undefined,
    );
    expect(result as string).toContain('Error processing image');
  });

  it('rejects a call missing required fields BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('process_image', { input_path: '/tmp/in.png' }, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── P1-3d-5 slice 2b: run_command ────────────────────────────────────────────
//
// 🔴 SECURITY-RELEVANT dispatch path (see index.ts's "P1-3d-5 slice 2b:
// run_command" doc section): the tests below run the REAL `runCommandTool`
// (same discipline as every other tool in this file — not mocked) through
// `executeLocalTool`, i.e. exactly the local-dispatch call
// `agentLoopHost.ts`'s `executeAnyTool` makes AFTER `approval.check` already
// returned `{decision:'allow'}` — that upstream gate itself (commandSafety,
// `registry.ts:295`, reached via the shell's `approval.check` handler) is
// tool-name-agnostic and already covered generically by
// `agentLoopHost.test.ts`'s "local tool dispatch (P1-3d-1 / P1-3d-3 approval
// gate)" describe block (it mocks THIS module and exercises the gate against
// any registered local tool — run_command included now that it's
// registered, no run_command-specific wiring needed there). This describe
// block's job is narrower: prove run_command is actually reachable and
// functional through the SAME dispatch function every other local tool here
// goes through, i.e. that it truly "dispatches through the approval gate"
// rather than silently bypassing local registration.
describe('executeLocalTool — run_command (P1-3d-5 slice 2b)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('runs locally via the mocked native invoke("run_shell_command") and returns the formatted output', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: 'hello', stderr: '' });

    const result = await executeLocalTool('run_command', { command: 'echo hello' }, undefined, undefined);

    expect(result as string).toContain('stdout:\nhello');
    expect(result as string).toContain('exit code: 0');
    expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({ command: 'echo hello' }));
  });

  it('preserves ToolExecutionContext.abortSignal so local run_command can reverse abort_command on Stop', async () => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
    const controller = new AbortController();
    let resolveShell!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveShell = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return { code: 0, stdout: '', stderr: '' };
    });

    const running = executeLocalTool(
      'run_command',
      { command: 'sleep 60' },
      { abortSignal: controller.signal, workspacePath: '/ws' },
      undefined,
    );

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_shell_command',
        expect.objectContaining({ command: 'sleep 60', commandId: expect.stringMatching(/^run-command-/) }),
      );
    });
    const shellCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_shell_command');
    const commandId = (shellCall?.[1] as { commandId: string }).commandId;

    controller.abort();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId });
    });
    resolveShell({ code: -1, stdout: '', stderr: '[Command aborted]' });
    const result = await running;
    expect(String(result)).toContain('exit code: -1');
  });

  it('rejects a call missing required fields BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('run_command', {}, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('catches an invoke rejection and returns it as an error STRING (never throws) — same dispatch-layer contract as every other local tool in this file', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('spawn failed'));

    const result = await executeLocalTool('run_command', { command: 'ls' }, undefined, undefined);

    expect(result as string).toContain('Error executing command');
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

// ── P1-3d-5 slice 3: delete_file ─────────────────────────────────────────────
//
// 🔴 SECURITY-RELEVANT: delete_file is the most destructive local tool. Two
// invariants must survive the local-dispatch path: (1) it reverses
// `move_to_trash` (recoverable OS-Trash move, newly allowlisted in
// agentLoopRunner.ts) — NEVER a permanent delete; (2) its catastrophic-target
// hard-block (filesystem root / home dir) runs INSIDE the real execute() —
// which runs here in the sidecar — and refuses BEFORE any `move_to_trash`
// call (fail-closed regardless of permission mode). The tool-level hard-block
// is also covered by fileTools.test.ts; this block proves it survives the
// `executeLocalTool` dispatch path specifically (no wrapper/validation strips
// it). Its write-path approval (checkWritePath) is applied upstream via the
// same tool-name-agnostic `approval.check` gate every local tool goes through.
describe('executeLocalTool — delete_file (P1-3d-5 slice 3)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it('reverses move_to_trash (recoverable) for a normal path', async () => {
    const result = await executeLocalTool('delete_file', { path: '/tmp/x/f.txt' }, undefined, undefined);
    expect(typeof result).toBe('string');
    expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: '/tmp/x/f.txt' });
  });

  it('🔴 refuses a catastrophic target (filesystem root) via local dispatch and NEVER calls move_to_trash', async () => {
    const result = await executeLocalTool('delete_file', { path: '/' }, undefined, undefined);
    expect(typeof result).toBe('string');
    expect(invoke).not.toHaveBeenCalledWith('move_to_trash', expect.anything());
  });

  it('rejects a call missing required fields BEFORE ever invoking execute() (pre-flight validation)', async () => {
    const result = await executeLocalTool('delete_file', {}, undefined, undefined);
    expect(result as string).toContain('missing required parameter');
    expect(invoke).not.toHaveBeenCalled();
  });
});
