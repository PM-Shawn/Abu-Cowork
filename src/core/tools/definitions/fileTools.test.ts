import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { writeTextFile, readTextFile, readFile, exists, stat } from '@tauri-apps/plugin-fs';
import { readFileTool, writeFileTool, deleteFileTool, editFileTool, searchFilesTool, findFilesTool, checkOpenDocumentTool } from './fileTools';
import { registerBuiltinTools } from '../builtins';
import { toolRegistry } from '../registry';
import { platform } from '@tauri-apps/plugin-os';
import { initPlatform } from '../../../utils/platform';
import { TOOL_NAMES } from '../toolNames';
import { recordFileVersion } from '../fileReadRecords';
import { PICTURE_ZOOM_NOTE } from '../fileRead/imageCaption';
import { sha256Hex } from '@/core/session/turnUndoRecord';
import type { ToolExecutionContext } from '@/types';

/** What a read_file of `path` leaves recorded: plugin-fs readFile answers empty bytes here. */
async function markRead(path: string, context: ToolExecutionContext): Promise<void> {
  await recordFileVersion(path, await sha256Hex(new Uint8Array()), context);
}

const snapshotBeforeAiEditMock = vi.fn().mockResolvedValue(undefined);
const captureTurnFileBeforeMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/utils/aiEditSnapshots', () => ({
  captureTurnFileBefore: (...args: unknown[]) => captureTurnFileBeforeMock(...args),
  snapshotBeforeAiEdit: (...args: unknown[]) => snapshotBeforeAiEditMock(...args),
}));

const bindWorkspaceFromWriteMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../agent/defaultWorkspace', () => ({
  bindWorkspaceFromWrite: (...args: unknown[]) => bindWorkspaceFromWriteMock(...args),
}));

// Regression coverage for the shell-injection fixes in the PDF branch of
// readFileTool. These tests prove the *interface contract* — the migrated
// call sites must dispatch to `run_argv_command` with the raw filePath as
// an argv element, never to `run_shell_command` with an interpolated
// command string. If anyone regresses this (e.g. by going back to
// `pdftotext "${filePath}" -`), these tests fail immediately.
//
// Verified-exploitable payloads (see T1 verification in the fix commit):
//   - `/tmp/x"; touch /tmp/PWN; y=".pdf`  — double-quote breakout
//   - `/tmp/x$(touch /tmp/PWN)y.pdf`       — command substitution
//   - `` /tmp/x`touch /tmp/PWN`y.pdf ``    — backtick substitution

const EVIL_PDF_QUOTE = '/tmp/x"; touch /tmp/ABU_PWN; y=".pdf';
const EVIL_PDF_DOLLAR = '/tmp/x$(touch /tmp/ABU_PWN)y.pdf';
const EVIL_PDF_BACKTICK = '/tmp/x`touch /tmp/ABU_PWN`y.pdf';

type InvokePayload = { program: string; args: string[]; timeout?: number };

function firstCall() {
  return vi.mocked(invoke).mock.calls[0] as unknown as [string, InvokePayload];
}

function nthCall(n: number) {
  return vi.mocked(invoke).mock.calls[n] as unknown as [string, InvokePayload];
}

afterEach(() => {
  delete (globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  }).__ABU_SHELL__;
});

/** A probe answer as the command host returns it. */
function probeOutput(value: Record<string, unknown>) {
  return { code: 0, stdout: JSON.stringify(value), stderr: '' };
}

/** A pdf-read answer for one page with an intact text layer. */
function onePagePdf(text = 'page text') {
  return probeOutput({
    ok: true, pages: 1, unexamined_from: null, text_cut_at: null, seconds: 0.1,
    list: [{ n: 1, w: 595, h: 842, chars: 900, garbled: false, ocr: false, images: 0, image_share: 0, paths: 2, text }],
  });
}

const PYTHON_MISSING = { code: 127, stdout: '', stderr: 'python3: command not found' };

describe('readFileTool — PDF shell injection regression', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(exists).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.mocked(exists).mockResolvedValue(false);
  });

  it('document probe: dispatches run_argv_command with the file path as the last raw argv element', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(onePagePdf('extracted text'));

    const result = await readFileTool.execute({ path: EVIL_PDF_QUOTE });

    expect(String(result)).toContain('[PDF: 1 page]');
    expect(String(result)).toContain('--- Page 1 ---\nextracted text');
    expect(invoke).toHaveBeenCalledTimes(1);

    const [cmdName, payload] = firstCall();
    expect(cmdName).toBe('run_argv_command');
    expect(payload.program).toBe('python3');
    expect(payload.args[0]).toBe('-c');
    // The program text never carries the path; the operation and its options
    // are separate elements; the path is the last element, unescaped.
    expect(payload.args[1]).not.toContain(EVIL_PDF_QUOTE);
    expect(payload.args[2]).toBe('pdf-read');
    expect(JSON.parse(payload.args[3])).toMatchObject({ render: true });
    expect(payload.args[4]).toBe(EVIL_PDF_QUOTE);
    expect(payload).not.toHaveProperty('commandId');
  });

  it('routes task aborts to abort_command for the active PDF reader process in Electron', async () => {
    const runtime = globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    };
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_argv_command') {
        return await new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return { code: 0, stdout: '', stderr: '' };
    });

    const running = readFileTool.execute(
      { path: EVIL_PDF_QUOTE },
      { abortSignal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_argv_command',
        expect.objectContaining({ program: 'python3', commandId: expect.stringMatching(/^read-pdf-/) }),
      );
    });
    const [, payload] = firstCall() as unknown as [string, InvokePayload & { commandId: string }];

    controller.abort();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId: payload.commandId });
    });
    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    const result = await running;
    expect(String(result)).toContain('PDF extraction was aborted');
    // An aborted read starts no fallback extractor.
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'run_argv_command')).toHaveLength(1);
  });

  it('falls back to pdftotext, then pdfplumber, only when Python cannot run — still argv, still verbatim', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(PYTHON_MISSING)
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'pdftotext not installed' })
      .mockResolvedValueOnce({ code: 0, stdout: 'plumber text', stderr: '' });

    const result = String(await readFileTool.execute({ path: EVIL_PDF_DOLLAR }));

    // The fallback says what was not examined.
    expect(result).toMatch(/^\[Text only: the document reader \(the bundled Python\) could not run/);
    expect(result.endsWith('plumber text')).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);

    const [cmd1, payload1] = nthCall(1);
    expect(cmd1).toBe('run_argv_command');
    expect(payload1.program).toBe('pdftotext');
    expect(payload1.args).toEqual([EVIL_PDF_DOLLAR, '-']);

    const [cmd2, payload2] = nthCall(2);
    expect(cmd2).toBe('run_argv_command');
    expect(payload2.program).toBe('python3');
    expect(payload2.args[0]).toBe('-c');
    expect(payload2.args[1]).not.toContain(EVIL_PDF_DOLLAR);
    expect(payload2.args[1]).not.toContain('$(');
    expect(payload2.args[1]).toContain('sys.argv[1]');
    expect(payload2.args[2]).toBe(EVIL_PDF_DOLLAR);
  });

  it('never dispatches run_shell_command when reading a PDF', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(onePagePdf());
    await readFileTool.execute({ path: EVIL_PDF_BACKTICK });

    const shellCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === 'run_shell_command');
    expect(shellCalls).toHaveLength(0);
  });

  it('PDFPLUMBER_SCRIPT does not contain any shell metacharacter interpolation', async () => {
    // Observe the script by triggering the last fallback
    vi.mocked(invoke)
      .mockResolvedValueOnce(PYTHON_MISSING)
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    await readFileTool.execute({ path: '/tmp/benign.pdf' });

    const [, payload] = nthCall(2);
    const script = payload.args[1];
    expect(script).not.toContain('${');
    expect(script).not.toContain('$(');
    expect(script).not.toMatch(/`[^`]*`/);
    expect(script).toContain('sys.argv[1]');
  });

  it('gives the install hint only when Python could not run', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 127, stdout: '', stderr: 'python3: command not found' });
    const missing = String(await readFileTool.execute({ path: '/tmp/a.pdf' }));
    expect(missing).toMatch(/Install|install/);

    vi.mocked(invoke).mockReset()
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Segmentation fault' })
      .mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    const crashed = String(await readFileTool.execute({ path: '/tmp/a.pdf' }));
    expect(crashed).toMatch(/^Error: The PDF reader stopped before finishing \(Segmentation fault\)/);
    expect(crashed).not.toMatch(/install/i);
  });

  it('reports a password-protected PDF as such, without a fallback', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(probeOutput({ ok: false, error: 'RuntimeError', message: 'password-protected' }));
    const result = String(await readFileTool.execute({ path: '/tmp/locked.pdf' }));
    expect(result).toMatch(/^Error: This PDF is password-protected/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('passes pages as ranges and refuses a malformed one before running anything', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(onePagePdf());
    await readFileTool.execute({ path: '/tmp/a.pdf', pages: '3-7, 9, 12-' });
    const [, payload] = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_argv_command') as [string, InvokePayload];
    expect(JSON.parse(payload.args[3]).pages).toEqual([[3, 7], [9, 9], [12, null]]);

    vi.mocked(invoke).mockReset();
    const result = String(await readFileTool.execute({ path: '/tmp/a.pdf', pages: 'first page' }));
    expect(result).toMatch(/^Error: pages could not be read/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('attaches no page images and asks for none when the model cannot see them', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(onePagePdf());
    await readFileTool.execute({ path: '/tmp/a.pdf' }, { supportsVision: false });
    expect(JSON.parse(firstCall()[1].args[3]).render).toBe(false);
  });
});

// Regression coverage for the vision-leak incident (conversation mr6949f59zuixs):
// a non-vision model (glm-5.1-external) read PNGs extracted from a zip; read_file
// returned base64 image blocks, which the provider rejected with 400
// ("messages.content.type 取值范围 ['text']"). read_file must not emit image
// content when the active model has no vision capability — it should return a
// text note so the model can tell the user gracefully, without reading the bytes.
describe('readFileTool — non-vision model image gating', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(exists).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.mocked(exists).mockResolvedValue(false);
  });

  it('returns a text note (no image block) when supportsVision is false', async () => {
    const result = await readFileTool.execute({ path: '/tmp/图片.png' }, { supportsVision: false });
    expect(typeof result).toBe('string');
    expect(result as string).toContain('/tmp/图片.png');
    expect(result as string).toContain('no vision capability');
    // Must NOT have produced an image content block (which would require
    // reading the bytes — plugin-fs.readFile isn't even mocked, so hitting
    // that path would throw and fail this test).
    expect(Array.isArray(result)).toBe(false);
  });

  it('does not short-circuit to the skip note for a vision-capable (default) model', async () => {
    // supportsVision unset → treated as vision-capable → image branch runs and
    // tries to read bytes. plugin-fs.readFile is unmocked, so the attempt
    // surfaces as an error string rather than the skip note — the point is it
    // did NOT take the non-vision shortcut.
    const result = await readFileTool.execute({ path: '/tmp/图片.png' });
    expect(String(result)).not.toContain('no vision capability');
  });
});

describe('readFileTool: a plain picture read labels the picture', () => {
  /** A PNG header that declares its size. */
  const png = (w: number, h: number) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bytes.buffer).setUint32(16, w);
    new DataView(bytes.buffer).setUint32(20, h);
    return bytes;
  };

  it('puts one label block before the image: the file name, its pixel size and how to look closer', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readFile).mockResolvedValueOnce(png(640, 480));
    try {
      const result = await readFileTool.execute({ path: '/tmp/work/photo.png' }, {});
      expect(result).toEqual([
        { type: 'text', text: `[Image: photo.png (640×480 px), shown at 640×480 px. ${PICTURE_ZOOM_NOTE}]` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: expect.any(String) } },
      ]);
      expect(JSON.stringify(result)).not.toContain('/tmp/work');
    } finally {
      vi.mocked(exists).mockResolvedValue(false);
    }
  });

  it('gives the size of the copy the model sees when the picture was scaled down', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    // Over 2 MB, which read_file hands to the native resizer.
    const original = new Uint8Array(3 * 1024 * 1024);
    original.set(png(4000, 3000));
    const processImage = vi.fn().mockResolvedValue(png(1280, 960));
    const files = {
      readFile: vi.fn().mockResolvedValue(original),
      exists: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue({ size: original.length, isFile: true, isDirectory: false }),
      processImage,
    } as unknown as ToolExecutionContext['files'];
    try {
      const result = await readFileTool.execute({ path: '/tmp/work/big.png' }, { files });
      expect(Array.isArray(result) && result[0]).toEqual({ type: 'text', text: `[Image: big.png (4000×3000 px), shown at 1280×960 px. ${PICTURE_ZOOM_NOTE}]` });
    } finally {
      vi.mocked(exists).mockResolvedValue(false);
    }
  });
});

describe('search/find file tools — task command scope', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('adds an Electron commandId to search_files shell execution when context carries a task signal', async () => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.mocked(invoke).mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });

    await searchFilesTool.execute(
      { pattern: 'needle', path: '/tmp/project' },
      { abortSignal: new AbortController().signal },
    );

    expect(invoke).toHaveBeenCalledWith(
      'run_shell_command',
      expect.objectContaining({ commandId: expect.stringMatching(/^search-files-/) }),
    );
  });

  it('adds an Electron commandId to find_files shell execution when context carries a task signal', async () => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '/tmp/project/a.ts\n', stderr: '' });

    await findFilesTool.execute(
      { pattern: '*.ts', path: '/tmp/project' },
      { abortSignal: new AbortController().signal },
    );

    expect(invoke).toHaveBeenCalledWith(
      'run_shell_command',
      expect.objectContaining({ commandId: expect.stringMatching(/^find-files-/) }),
    );
  });
});

// Regression coverage for the CJK-mojibake bug: AI-generated HTML files had no
// charset declaration, so opening them in a browser (file://, no HTTP header to
// rely on) or via the in-app preview server fell back to a locale default (GBK on
// zh-CN Windows/macOS) and mangled Chinese content. write_file must inject
// `<meta charset="utf-8">` for .html/.htm unless the document already declares one.
describe('writeFileTool — HTML charset injection', () => {
  beforeEach(() => {
    vi.mocked(writeTextFile).mockClear();
  });

  it('injects <meta charset="utf-8"> right after <head> when missing', async () => {
    const html = '<html><head><title>你好</title></head><body>世界</body></html>';
    await writeFileTool.execute({ path: '/tmp/test.html', content: html });

    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = vi.mocked(writeTextFile).mock.calls[0];
    expect(writtenContent).toContain('<meta charset="utf-8">');
    // Must be inserted immediately after the <head> tag, before the rest of the head content.
    const headIdx = (writtenContent as string).indexOf('<head>');
    const metaIdx = (writtenContent as string).indexOf('<meta charset="utf-8">');
    const titleIdx = (writtenContent as string).indexOf('<title>');
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeGreaterThan(headIdx);
    expect(metaIdx).toBeLessThan(titleIdx);
  });

  it('does not double-inject when a charset meta tag is already present', async () => {
    const html = '<html><head><meta charset="utf-8"><title>你好</title></head><body>世界</body></html>';
    await writeFileTool.execute({ path: '/tmp/test.html', content: html });

    const [, writtenContent] = vi.mocked(writeTextFile).mock.calls[0];
    const occurrences = (writtenContent as string).match(/charset/gi) ?? [];
    expect(occurrences.length).toBe(1);
    expect(writtenContent).toBe(html);
  });

  it('prefixes a BOM for an HTML fragment with no <head>/<html> structure', async () => {
    const fragment = '<div>你好世界</div>';
    await writeFileTool.execute({ path: '/tmp/fragment.html', content: fragment });

    const [, writtenContent] = vi.mocked(writeTextFile).mock.calls[0];
    expect((writtenContent as string).startsWith('\uFEFF')).toBe(true);
    expect(writtenContent).toBe('\uFEFF' + fragment);
  });
});

describe('write/edit — a file another program holds open', () => {
  // Office and WPS open a document with a share mode that denies writes, so a
  // spreadsheet the user is looking at fails the write with EBUSY. Handed back
  // raw that reads as a glitch, and the model retries a lock that will not
  // clear on its own. It has to come back as a fact about the world.
  const busy = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`${code}: resource busy or locked, open 'C:/table.csv'`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  beforeEach(() => {
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(readTextFile).mockClear();
  });

  // A queued one-shot rejection that a test never reaches would fire in the
  // next one instead, so nothing here is allowed to leak.
  afterEach(() => {
    vi.mocked(writeTextFile).mockReset();
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    vi.mocked(exists).mockResolvedValue(false);
  });

  it('explains an EBUSY write instead of inviting a retry', async () => {
    vi.mocked(writeTextFile).mockRejectedValueOnce(busy('EBUSY'));
    const result = String(await writeFileTool.execute({ path: 'C:/table.csv', content: 'x' }));
    expect(result).toMatch(/open and locked by another program/);
    expect(result).toMatch(/retry will not clear it/);
    expect(result).not.toMatch(/EBUSY/);
  });

  /// The local plugin-fs path crosses Electron IPC, which serializes only
  /// name/message/stack — the errno never arrives. Matching the code alone
  /// made this whole branch dead on that transport while the tests, which
  /// attach `.code` by hand below the transport, stayed green.
  it('explains it from the message alone when the errno did not survive', async () => {
    const stripped = new Error("EBUSY: resource busy or locked, open 'C:/table.csv'");
    vi.mocked(writeTextFile).mockRejectedValueOnce(stripped);
    const result = String(await writeFileTool.execute({ path: 'C:/table.csv', content: 'x' }));
    expect(result).toMatch(/open and locked by another program/);
  });

  /// A protected directory is not an open document, and telling the user to
  /// close an application they do not have open sends them after the wrong
  /// thing.
  it.each(['EPERM', 'EACCES'])('leaves a %s permission error as it was', async (code) => {
    const denied = new Error(`${code}: operation not permitted, open 'C:/Program Files/x.txt'`) as NodeJS.ErrnoException;
    denied.code = code;
    vi.mocked(writeTextFile).mockRejectedValueOnce(denied);
    const result = String(await writeFileTool.execute({ path: 'C:/Program Files/x.txt', content: 'x' }));
    expect(result).not.toMatch(/open and locked by another program/);
    expect(result).toMatch(new RegExp(code));
  });

  it('explains the same for an edit', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValueOnce('before');
    vi.mocked(writeTextFile).mockRejectedValueOnce(busy('EBUSY'));
    const result = String(await editFileTool.execute({
      path: 'C:/table.csv',
      old_content: 'before',
      new_content: 'after',
    }));
    expect(result).toMatch(/open and locked by another program/);
  });

  it('leaves an unrelated failure as it was', async () => {
    const other = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
    other.code = 'ENOSPC';
    vi.mocked(writeTextFile).mockRejectedValueOnce(other);
    const result = String(await writeFileTool.execute({ path: 'C:/table.csv', content: 'x' }));
    expect(result).toMatch(/no space left on device/);
  });
});

describe('deleteFileTool \u2014 move to trash (safe delete)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('routes deletion through move_to_trash and reports the path', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    const target = '/Users/x/Downloads/old-report.csv';
    const result = await deleteFileTool.execute({ path: target }, {} as never);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = vi.mocked(invoke).mock.calls[0] as unknown as [string, { path: string }];
    expect(cmd).toBe('move_to_trash');
    expect(payload.path).toBe(target);
    // Locale-robust: the success message always interpolates {path}.
    expect(result).toContain(target);
  });

  it('is fail-closed: on trash failure it reports an error and never shells out to rm', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('trash boom'));

    const result = await deleteFileTool.execute({ path: '/Users/x/f.txt' }, {} as never);

    // Only one invoke, and it was the trash command \u2014 no run_command / run_shell_command fallback.
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd] = vi.mocked(invoke).mock.calls[0] as unknown as [string, unknown];
    expect(cmd).toBe('move_to_trash');
    // Locale-robust: the failure message always interpolates {error}.
    expect(result).toContain('trash boom');
  });

  it('captures the file for the turn, with the loop of the tool context, before moving it to the trash', async () => {
    captureTurnFileBeforeMock.mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await deleteFileTool.execute({ path: '/Users/x/old.md' }, { loopId: 'loop-7' } as never);

    expect(captureTurnFileBeforeMock).toHaveBeenCalledWith('/Users/x/old.md', 'loop-7');
    expect(captureTurnFileBeforeMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invoke).mock.invocationCallOrder[0],
    );
  });

  it('captures nothing for a target it refuses to delete', async () => {
    captureTurnFileBeforeMock.mockClear();
    await deleteFileTool.execute({ path: '/' }, { loopId: 'loop-7' } as never);
    expect(captureTurnFileBeforeMock).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('deleteFileTool — catastrophic target hard block', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('refuses to delete the filesystem root and never calls invoke', async () => {
    const result = await deleteFileTool.execute({ path: '/' }, {} as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toContain('/');
  });

  it('refuses to delete the home directory and never calls invoke', async () => {
    // Home is mocked to '/Users/testuser' in src/test/setup.ts.
    const result = await deleteFileTool.execute({ path: '/Users/testuser' }, {} as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toContain('/Users/testuser');
  });

  it('refuses to delete the home directory with a trailing slash', async () => {
    await deleteFileTool.execute({ path: '/Users/testuser/' }, {} as never);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('still moves a normal in-workspace path to Trash', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    const target = '/Users/testuser/Projects/myapp/old-file.txt';
    const result = await deleteFileTool.execute({ path: target }, {} as never);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = vi.mocked(invoke).mock.calls[0] as unknown as [string, { path: string }];
    expect(cmd).toBe('move_to_trash');
    expect(payload.path).toBe(target);
    expect(result).toContain(target);
  });
});

describe('delete_file registration', () => {
  it('is registered as a builtin tool', () => {
    registerBuiltinTools();
    expect(toolRegistry.has(TOOL_NAMES.DELETE_FILE)).toBe(true);
  });
});

// Regression coverage for the String.replace($-substitution) corruption bug:
// editFileTool did `content.replace(oldContent, newContent)` with a *string*
// replacement, so JS honored the special patterns `$$`, `$&`, `` $` ``, `$'`
// inside new_content (regardless of the search being a plain string). An LLM
// editing a file to insert text containing a literal `$` (prices, shell vars,
// regex/LaTeX snippets, git diffs) would silently write the WRONG bytes while
// the tool still reported "Successfully edited". The fix uses a function
// replacer so the replacement is inserted verbatim.
describe('editFileTool — new_content is inserted verbatim (no $-substitution)', () => {
  beforeEach(() => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
  });

  function writtenContent(): string {
    return vi.mocked(writeTextFile).mock.calls[0][1] as string;
  }

  it('does not expand `$&` into the matched old_content', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('a\nPLACEHOLDER\nb');

    const result = await editFileTool.execute({
      path: '/tmp/edit-dollar.txt',
      old_content: 'PLACEHOLDER',
      new_content: 'see $& again',
    });

    expect(String(result)).toContain('Successfully edited');
    // Buggy behavior would produce "see PLACEHOLDER again".
    expect(writtenContent()).toBe('a\nsee $& again\nb');
  });

  it('does not collapse `$$` into a single `$`', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('cost: TOKEN');

    await editFileTool.execute({
      path: '/tmp/edit-price.txt',
      old_content: 'TOKEN',
      new_content: 'was $$29.99',
    });

    // Buggy behavior would produce "cost: was $29.99".
    expect(writtenContent()).toBe('cost: was $$29.99');
  });

  it("does not expand `` $` `` or `$'` (pre/post-match insertion)", async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('before[X]after');

    await editFileTool.execute({
      path: '/tmp/edit-prepost.txt',
      old_content: '[X]',
      new_content: "a$`b$'c",
    });

    // Buggy behavior would splice in "before" (for $`) and "after" (for $').
    expect(writtenContent()).toBe("beforea$`b$'cafter");
  });

  it('still performs a normal edit with no `$` in the replacement', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('const a = 1;\nconst b = 2;');

    await editFileTool.execute({
      path: '/tmp/edit-plain.txt',
      old_content: 'const b = 2;',
      new_content: 'const b = 3;',
    });

    expect(writtenContent()).toBe('const a = 1;\nconst b = 3;');
  });
});

describe('AI edit pre-snapshot hook', () => {
  beforeEach(() => {
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(readTextFile).mockClear();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    snapshotBeforeAiEditMock.mockClear();
    snapshotBeforeAiEditMock.mockResolvedValue(undefined);
    bindWorkspaceFromWriteMock.mockClear();
    bindWorkspaceFromWriteMock.mockResolvedValue(undefined);
  });

  it('write_file snapshots before writing, passing loopId/conversationId', async () => {
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    const result = await writeFileTool.execute(
      { path: '/w/a.txt', content: 'new' },
      { loopId: 'loop1', conversationId: 'conv1' }
    );
    expect(result).toContain('Successfully wrote');
    expect(snapshotBeforeAiEditMock).toHaveBeenCalledWith('/w/a.txt', {
      loopId: 'loop1',
      conversationId: 'conv1',
    });
    // Snapshot must happen before the write.
    expect(snapshotBeforeAiEditMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(writeTextFile).mock.invocationCallOrder[0]
    );
  });

  it('does not persist a managed workspace binding for a background write', async () => {
    vi.mocked(writeTextFile).mockResolvedValue(undefined);

    const result = await writeFileTool.execute(
      { path: '/Users/testuser/Abu/remote/out.txt', content: 'new' },
      { conversationId: 'conv-im', interactionMode: 'background' },
    );

    expect(result).toContain('Successfully wrote');
    expect(bindWorkspaceFromWriteMock).not.toHaveBeenCalled();
  });

  it('keeps managed workspace binding for an explicitly foreground write', async () => {
    vi.mocked(writeTextFile).mockResolvedValue(undefined);

    const result = await writeFileTool.execute(
      { path: '/Users/testuser/Abu/desktop/out.txt', content: 'new' },
      { conversationId: 'conv-desktop', interactionMode: 'foreground' },
    );

    expect(result).toContain('Successfully wrote');
    expect(bindWorkspaceFromWriteMock).toHaveBeenCalledWith(
      'conv-desktop',
      '/Users/testuser/Abu/desktop/out.txt',
      'foreground',
    );
  });

  it('edit_file passes the already-read content as knownContent', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue('hello old world');
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    const result = await editFileTool.execute(
      { path: '/w/a.txt', old_content: 'old', new_content: 'new' },
      { loopId: 'loop1', conversationId: 'conv1' }
    );
    expect(result).toContain('Successfully edited');
    expect(snapshotBeforeAiEditMock).toHaveBeenCalledWith('/w/a.txt', {
      loopId: 'loop1',
      conversationId: 'conv1',
      knownContent: 'hello old world',
    });
  });

  it('edit_file does not snapshot when validation fails (old_content not found)', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue('nothing matches');
    const result = await editFileTool.execute(
      { path: '/w/a.txt', old_content: 'absent', new_content: 'new' },
      { loopId: 'loop1' }
    );
    expect(result).toContain('Error: old_content not found');
    expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
  });

  it('edit_file does not snapshot when the file does not exist', async () => {
    vi.mocked(exists).mockResolvedValue(false);
    const result = await editFileTool.execute(
      { path: '/w/missing.txt', old_content: 'a', new_content: 'b' },
      { loopId: 'loop1' }
    );
    expect(result).toContain('Error: File not found');
    expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
  });
});

// Exact-match misses used to burn a full LLM round trip (model re-reads the
// file and retries) even when old_content differed from the file only in
// whitespace — trailing spaces, tab↔space, per-line trim. The tolerant
// fallback reuses fuzzyFindAndReplace (skill-patch machinery) and only
// applies a unique, unambiguous match; anything else still errors.
describe('editFileTool — whitespace-tolerant fallback', () => {
  beforeEach(() => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(writeTextFile).mockClear();
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    snapshotBeforeAiEditMock.mockClear();
  });

  function writtenContent(): string {
    return vi.mocked(writeTextFile).mock.calls[0][1] as string;
  }

  it('applies an edit when old_content carries trailing whitespace the file lacks', async () => {
    // The model quoted the line with a trailing space that is not in the file.
    vi.mocked(readTextFile).mockResolvedValueOnce('const a = 1;\nconst b = 2;');

    const result = await editFileTool.execute({
      path: '/w/drift.ts',
      old_content: 'const a = 1; \nconst b = 2;',
      new_content: 'const a = 42;\nconst b = 2;',
    });

    expect(String(result)).toContain('Successfully edited');
    expect(String(result)).toContain('whitespace-tolerant fallback');
    expect(writtenContent()).toBe('const a = 42;\nconst b = 2;');
    expect(snapshotBeforeAiEditMock).toHaveBeenCalledTimes(1);
  });

  it('applies an edit when indentation drifted from tabs to spaces', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('if (x) {\n\treturn 1;\n}');

    const result = await editFileTool.execute({
      path: '/w/tabs.ts',
      old_content: 'if (x) {\n  return 1;\n}',
      new_content: 'if (x) {\n  return 2;\n}',
    });

    expect(String(result)).toContain('Successfully edited');
    expect(writtenContent()).toContain('return 2;');
  });

  it('still errors when the fuzzy match is ambiguous (multiple locations)', async () => {
    // Two locations match after per-line trim — must NOT silently pick one.
    vi.mocked(readTextFile).mockResolvedValueOnce('foo() \nbar\nfoo() \nbaz');

    const result = await editFileTool.execute({
      path: '/w/ambiguous.ts',
      old_content: 'foo()',
      new_content: 'qux()',
    });

    expect(String(result)).toContain('Error');
    expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled();
    expect(snapshotBeforeAiEditMock).not.toHaveBeenCalled();
  });

  it('still errors with the similar-line hint when nothing matches at all', async () => {
    vi.mocked(readTextFile).mockResolvedValueOnce('completely different content');

    const result = await editFileTool.execute({
      path: '/w/nomatch.ts',
      old_content: 'function doesNotExist() {}',
      new_content: 'function replacement() {}',
    });

    expect(String(result)).toContain('Error: old_content not found');
    expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled();
  });
});

// The routing rule this serves: a file open in its application must not be
// written behind that application's back. The check is what makes the rule
// enforceable — before it, the assistant found out from a PermissionError
// halfway through, with no idea which app or whether work would be lost.
describe('check_open_document', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  async function check(report: unknown) {
    vi.mocked(invoke).mockResolvedValueOnce(report);
    return (await checkOpenDocumentTool.execute({ path: 'F:\\work\\book.xlsx' }, undefined)) as string;
  }

  it('says it is safe to write when nothing has the file open', async () => {
    const result = await check({ supported: true, complete: true, documents: [] });
    expect(result).toMatch(/没有开在|is not open/);
  });

  // The distinction the COM leg exists for. Both cases block the write, but
  // only one of them destroys work, and the user has to be told which.
  it('separates unsaved edits from a merely locked file', async () => {
    const saved = await check({
      supported: true,
      complete: true,
      documents: [{ app: 'wps-spreadsheets', name: 'book.xlsx', path: 'F:\\work\\book.xlsx', unsaved: false, samePath: true }],
    });
    const unsaved = await check({
      supported: true,
      complete: true,
      documents: [{ app: 'wps-spreadsheets', name: 'book.xlsx', path: 'F:\\work\\book.xlsx', unsaved: true, samePath: true }],
    });
    expect(unsaved).not.toEqual(saved);
    expect(unsaved).toMatch(/没有保存|not saved/);
    expect(saved).toMatch(/WPS 表格|WPS Spreadsheets/);
  });

  it('does not report a same-named file from elsewhere as this file being open', async () => {
    const result = await check({
      supported: true,
      complete: true,
      documents: [{ app: 'excel', name: 'book.xlsx', path: 'D:\\archive\\book.xlsx', unsaved: true, samePath: false }],
    });
    expect(result).toMatch(/D:\\archive/);
    expect(result).not.toMatch(/没有保存|not saved/);
  });

  // "Could not tell" must never be flattened into "nothing is open" — that
  // turns a question for the user into a silent overwrite.
  it('treats an unanswerable check as possibly open', async () => {
    const result = await check({ supported: true, complete: false, documents: [] });
    expect(result).toMatch(/无法确定|Could not tell/);
  });

  it('treats an unreachable host as possibly open rather than as not open', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('helper is down'));
    const result = (await checkOpenDocumentTool.execute({ path: 'F:\\work\\book.xlsx' }, undefined)) as string;
    expect(result).toMatch(/无法确定|Could not tell/);
    expect(result).not.toMatch(/没有开在|is not open/);
  });

  it('answers instead of failing where there is no attach surface', async () => {
    const result = await check({ supported: false, complete: false, documents: [] });
    expect(result).toMatch(/Windows/);
  });

  it('is registered, so a document skill can reach it', () => {
    registerBuiltinTools();
    expect(toolRegistry.get(TOOL_NAMES.CHECK_OPEN_DOCUMENT)).toBeDefined();
  });
});

/// The EBUSY message is the delivery path that reaches a user who has Computer
/// Use switched off: the channel-gate prompt section ships with that setting,
/// this string ships with the failure. Left untested, the hint would be a
/// dead branch — `isWindows()` is false by default in this suite, so every
/// other test in this file exercises the macOS side of it.
describe('the locked-file message points at the check, on Windows', () => {
  afterEach(async () => {
    // `cached` starts as null and has no public reset. Landing on macOS keeps
    // isWindows() false, which is what every other test in this file assumes.
    vi.mocked(platform).mockResolvedValue('macos');
    await initPlatform();
  });

  beforeEach(() => {
    vi.mocked(exists).mockReset().mockResolvedValue(false);
  });

  it('names check_open_document so the model asks who holds the file', async () => {
    vi.mocked(platform).mockResolvedValue('windows');
    await initPlatform();

    vi.mocked(writeTextFile).mockRejectedValueOnce(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
    );
    const result = String(await writeFileTool.execute({ path: 'C:/table.csv', content: 'x' }));

    expect(result).toMatch(/check_open_document/);
    expect(result).toMatch(/open and locked by another program/);
  });

  it('leaves the message alone where the check does not exist', async () => {
    vi.mocked(platform).mockResolvedValue('macos');
    await initPlatform();

    vi.mocked(writeTextFile).mockRejectedValueOnce(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
    );
    const result = String(await writeFileTool.execute({ path: '/tmp/table.csv', content: 'x' }));

    expect(result).not.toMatch(/check_open_document/);
  });
});

describe('file change reporting', () => {
  const reportMetadata = vi.fn();

  function setDiskDefaults() {
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(stat).mockReset().mockResolvedValue({ isFile: true, size: 0 } as never);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(invoke).mockReset();
  }

  beforeEach(() => {
    reportMetadata.mockReset();
    setDiskDefaults();
  });

  afterEach(setDiskDefaults);

  describe('write_file', () => {
    it('reports a new file as created, with every line added', async () => {
      const result = await writeFileTool.execute(
        { path: '/w/outline.md', content: '# Title\nBody\n' },
        { reportMetadata },
      );

      expect(result).toBe('Successfully wrote 13 characters to /w/outline.md');
      expect(reportMetadata).toHaveBeenCalledTimes(1);
      expect(reportMetadata).toHaveBeenCalledWith({
        fileChange: {
          path: '/w/outline.md',
          kind: 'create',
          added: 2,
          deleted: 0,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+# Title', '+Body'] }],
        },
      });
      expect(readTextFile).not.toHaveBeenCalled();
    });

    it('reads the existing text before writing and reports the difference', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isFile: true, size: 8 } as never);
      vi.mocked(readTextFile).mockResolvedValue('one\ntwo\n');
      const context = { reportMetadata, conversationId: 'conv-report-diff' };
      await markRead('/w/a.txt', context);

      await writeFileTool.execute({ path: '/w/a.txt', content: 'one\n2\n' }, context);

      expect(vi.mocked(readTextFile).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(writeTextFile).mock.invocationCallOrder[0]);
      expect(reportMetadata.mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(writeTextFile).mock.invocationCallOrder[0]);
      expect(reportMetadata).toHaveBeenCalledWith({
        fileChange: {
          path: '/w/a.txt',
          kind: 'modify',
          added: 1,
          deleted: 1,
          hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+2'] }],
        },
      });
    });

    it('compares the text that reached the disk, not the content argument', async () => {
      await writeFileTool.execute({ path: '/w/table.csv', content: 'a,b\n' }, { reportMetadata });

      const written = vi.mocked(writeTextFile).mock.calls[0][1] as string;
      expect(written).toBe('﻿a,b\n');
      expect(reportMetadata.mock.calls[0][0].fileChange.hunks[0].lines).toEqual(['+﻿a,b']);
    });

    it('reports path and kind only when the existing file is over the size limit', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isFile: true, size: 2 * 1024 * 1024 + 1 } as never);
      const context = { reportMetadata, conversationId: 'conv-report-big' };
      await markRead('/w/big.log', context);

      const result = await writeFileTool.execute({ path: '/w/big.log', content: 'x' }, context);

      expect(result).toContain('Successfully wrote');
      expect(readTextFile).not.toHaveBeenCalled();
      expect(reportMetadata).toHaveBeenCalledWith({ fileChange: { path: '/w/big.log', kind: 'modify' } });
    });

    it('fails the write when the existing text cannot be read', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockRejectedValue(new Error('EACCES: permission denied'));
      const context = { reportMetadata, conversationId: 'conv-report-unreadable' };
      await markRead('/w/a.txt', context);

      const result = await writeFileTool.execute({ path: '/w/a.txt', content: 'x' }, context);

      expect(result).toContain('Error writing file');
      expect(result).toContain('EACCES');
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(reportMetadata).not.toHaveBeenCalled();
    });

    it('fails the write when it cannot tell whether the file exists', async () => {
      vi.mocked(exists).mockRejectedValue(new Error('transport closed'));

      const result = await writeFileTool.execute({ path: '/w/a.txt', content: 'x' }, { reportMetadata });

      expect(result).toContain('Error writing file');
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(reportMetadata).not.toHaveBeenCalled();
    });

    it('reports path and kind only for an existing path that is no regular file', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isFile: false, size: 0 } as never);
      const context = { reportMetadata, conversationId: 'conv-report-special' };
      await markRead('/w/a.txt', context);

      await writeFileTool.execute({ path: '/w/a.txt', content: 'x' }, context);

      expect(readTextFile).not.toHaveBeenCalled();
      expect(reportMetadata).toHaveBeenCalledWith({ fileChange: { path: '/w/a.txt', kind: 'modify' } });
    });

    it('reports nothing when the write fails', async () => {
      vi.mocked(writeTextFile).mockRejectedValue(new Error('ENOSPC: no space left on device'));

      const result = await writeFileTool.execute({ path: '/w/a.txt', content: 'x' }, { reportMetadata });

      expect(result).toContain('Error writing file');
      expect(reportMetadata).not.toHaveBeenCalled();
    });

    it('does not read the existing file for a caller that takes no metadata', async () => {
      vi.mocked(exists).mockResolvedValue(true);

      await writeFileTool.execute({ path: '/w/a.txt', content: 'x' }, {});

      expect(stat).not.toHaveBeenCalled();
      expect(readTextFile).not.toHaveBeenCalled();
    });
  });

  describe('edit_file', () => {
    beforeEach(() => {
      vi.mocked(exists).mockResolvedValue(true);
    });

    it('reports the changed lines with their context', async () => {
      vi.mocked(readTextFile).mockResolvedValue('a\nb\nc\nd\ne\n');

      const result = await editFileTool.execute(
        { path: '/w/plan.md', old_content: 'c', new_content: 'C' },
        { reportMetadata },
      );

      expect(result).toBe('Successfully edited /w/plan.md: replaced 1 line(s) with 1 line(s)');
      expect(reportMetadata).toHaveBeenCalledTimes(1);
      expect(reportMetadata).toHaveBeenCalledWith({
        fileChange: {
          path: '/w/plan.md',
          kind: 'modify',
          added: 1,
          deleted: 1,
          hunks: [{
            oldStart: 1,
            oldLines: 5,
            newStart: 1,
            newLines: 5,
            lines: [' a', ' b', '-c', '+C', ' d', ' e'],
          }],
        },
      });
      expect(reportMetadata.mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(writeTextFile).mock.invocationCallOrder[0]);
    });

    it('reports the text actually replaced by the whitespace-tolerant match', async () => {
      vi.mocked(readTextFile).mockResolvedValue('if (x) {\n\treturn 1;   \n}\n');

      const result = await editFileTool.execute(
        { path: '/w/a.ts', old_content: '  return 1;', new_content: '  return 2;' },
        { reportMetadata },
      );

      expect(String(result)).toContain('whitespace-tolerant fallback');
      const change = reportMetadata.mock.calls[0][0].fileChange;
      expect(change.kind).toBe('modify');
      expect(change.added).toBe(1);
      expect(change.deleted).toBe(1);
      expect(change.hunks[0].lines).toContain('-\treturn 1;   ');
    });

    it('reports nothing when old_content is not found', async () => {
      vi.mocked(readTextFile).mockResolvedValue('nothing matches');

      await editFileTool.execute({ path: '/w/a.txt', old_content: 'absent', new_content: 'x' }, { reportMetadata });

      expect(reportMetadata).not.toHaveBeenCalled();
    });

    it('reports nothing when the write fails', async () => {
      vi.mocked(readTextFile).mockResolvedValue('old');
      vi.mocked(writeTextFile).mockRejectedValue(new Error('EACCES: permission denied'));

      await editFileTool.execute({ path: '/w/a.txt', old_content: 'old', new_content: 'new' }, { reportMetadata });

      expect(reportMetadata).not.toHaveBeenCalled();
    });
  });

  describe('delete_file', () => {
    const target = '/Users/testuser/Projects/app/draft.md';

    it('reads the text before moving the file to Trash and reports it as deleted lines', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isFile: true, size: 8 } as never);
      vi.mocked(readTextFile).mockResolvedValue('one\ntwo\n');
      vi.mocked(invoke).mockResolvedValue(undefined);

      const result = await deleteFileTool.execute({ path: target }, { reportMetadata });

      expect(result).toContain(target);
      expect(vi.mocked(readTextFile).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[0]);
      expect(reportMetadata).toHaveBeenCalledWith({
        fileChange: {
          path: target,
          kind: 'delete',
          added: 0,
          deleted: 2,
          hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-one', '-two'] }],
        },
      });
    });

    it('reports path and kind only for a target that is a folder', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(stat).mockResolvedValue({ isFile: false, size: 0 } as never);
      vi.mocked(invoke).mockResolvedValue(undefined);

      const result = await deleteFileTool.execute({ path: target }, { reportMetadata });

      expect(result).toContain(target);
      expect(reportMetadata).toHaveBeenCalledWith({ fileChange: { path: target, kind: 'delete' } });
    });

    it('reports nothing when the move to Trash fails', async () => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue('one\n');
      vi.mocked(invoke).mockRejectedValue(new Error('trash boom'));

      const result = await deleteFileTool.execute({ path: target }, { reportMetadata });

      expect(result).toContain('trash boom');
      expect(reportMetadata).not.toHaveBeenCalled();
    });

    it('reads nothing for a refused target', async () => {
      await deleteFileTool.execute({ path: '/' }, { reportMetadata });

      expect(exists).not.toHaveBeenCalled();
      expect(reportMetadata).not.toHaveBeenCalled();
    });
  });
});

describe('file read outcome record', () => {
  const reportMetadata = vi.fn();

  function setDiskDefaults() {
    vi.mocked(stat).mockReset().mockResolvedValue({ isFile: true, size: 0 } as never);
    vi.mocked(readTextFile).mockReset().mockResolvedValue('');
    vi.mocked(invoke).mockReset();
  }

  beforeEach(() => {
    reportMetadata.mockReset();
    setDiskDefaults();
    vi.mocked(exists).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    setDiskDefaults();
    vi.mocked(exists).mockReset().mockResolvedValue(false);
  });

  it('records a whole text read from line one', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: true, size: 14 } as never);
    vi.mocked(readTextFile).mockResolvedValue('one\ntwo\nthree');

    await readFileTool.execute({ path: '/docs/notes.txt' }, { reportMetadata });

    expect(reportMetadata).toHaveBeenCalledWith({
      fileReadOutcome: { kind: 'text', startLine: 1, lineCount: 3, totalLines: 3, bodyStart: 0 },
    });
  });

  it('records a ranged read with the header length', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    vi.mocked(stat).mockResolvedValue({ isFile: true, size: 12000 } as never);
    vi.mocked(readTextFile).mockResolvedValue(lines.join('\n'));

    const result = await readFileTool.execute(
      { path: '/docs/long.txt', offset: 199, limit: 100 },
      { reportMetadata },
    ) as string;

    expect(reportMetadata).toHaveBeenCalledTimes(1);
    const { fileReadOutcome } = reportMetadata.mock.calls[0][0] as {
      fileReadOutcome: { kind: 'text'; startLine: number; lineCount: number; totalLines: number; bodyStart: number };
    };
    expect(fileReadOutcome).toMatchObject({ kind: 'text', startLine: 200, lineCount: 100, totalLines: 1500 });
    expect(fileReadOutcome.bodyStart).toBe(result.indexOf('\n') + 1);
    expect(result.slice(fileReadOutcome.bodyStart).split('\n')[0]).toBe(lines[199]);
  });

  it('records a notice for a range past the end', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: true, size: 14 } as never);
    vi.mocked(readTextFile).mockResolvedValue('one\ntwo\nthree');

    await readFileTool.execute({ path: '/docs/notes.txt', offset: 3, limit: 10 }, { reportMetadata });

    expect(reportMetadata).toHaveBeenCalledTimes(1);
    expect(reportMetadata).toHaveBeenCalledWith({ fileReadOutcome: { kind: 'notice' } });
  });

  it('records a notice for a file too large to read at once', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: true, size: 256 * 1024 + 1 } as never);
    vi.mocked(readTextFile).mockResolvedValue('a\nb');

    await readFileTool.execute({ path: '/docs/huge.log' }, { reportMetadata });

    expect(reportMetadata).toHaveBeenCalledWith({ fileReadOutcome: { kind: 'notice' } });
  });

  it('records a document for extracted PDF text', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(onePagePdf());

    const result = await readFileTool.execute({ path: '/docs/report.pdf' }, { reportMetadata });

    expect(String(result)).toContain('--- Page 1 ---\npage text');
    expect(reportMetadata).toHaveBeenCalledWith({ fileReadOutcome: { kind: 'document' } });
  });

  it('records a document for a PDF read that attaches page images', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(probeOutput({
      ok: true, pages: 1, unexamined_from: null, text_cut_at: null, seconds: 0.1,
      list: [{ n: 1, w: 595, h: 842, chars: 0, garbled: false, ocr: false, images: 1, image_share: 1, paths: 0, text: '', img: { data: 'AAAA', w: 10, h: 14 } }],
    }));

    const result = await readFileTool.execute({ path: '/docs/scan.pdf' }, { reportMetadata });

    expect(Array.isArray(result)).toBe(true);
    expect(reportMetadata).toHaveBeenCalledWith({ fileReadOutcome: { kind: 'document' } });
  });

  it('records nothing for a PDF whose extraction failed', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 1, stdout: '', stderr: 'broken' });

    await readFileTool.execute({ path: '/docs/report.pdf' }, { reportMetadata });

    expect(reportMetadata).not.toHaveBeenCalled();
  });

  it('records nothing for an image', async () => {
    await readFileTool.execute({ path: '/tmp/图片.png' }, { reportMetadata });

    expect(reportMetadata).not.toHaveBeenCalled();
  });

  it('records nothing when the read throws', async () => {
    vi.mocked(readTextFile).mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await readFileTool.execute({ path: '/docs/notes.txt' }, { reportMetadata });

    expect(result).toContain('EACCES');
    expect(reportMetadata).not.toHaveBeenCalled();
  });
});
