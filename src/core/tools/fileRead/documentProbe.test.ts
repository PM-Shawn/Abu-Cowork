import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ToolExecutionContext } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { cleanProbeDetail, DOCUMENT_PROBE_SCRIPT, PROCESSOR_MAX_INPUT_BYTES, runDocumentProbe, tooLargeError } from './documentProbe';

/** Electron's file processor validates every argument at this many characters. */
const PROCESSOR_ARGUMENT_LIMIT = 32_768;

describe('DOCUMENT_PROBE_SCRIPT', () => {
  it('fits one processor argument with room for the Windows quoting of its quotes', () => {
    const quotes = DOCUMENT_PROBE_SCRIPT.split('"').length - 1;
    expect(DOCUMENT_PROBE_SCRIPT.length + quotes).toBeLessThan(PROCESSOR_ARGUMENT_LIMIT / 2);
  });

  it('holds no backtick and no template interpolation', () => {
    expect(DOCUMENT_PROBE_SCRIPT).not.toContain('`');
    expect(DOCUMENT_PROBE_SCRIPT).not.toContain('${');
  });

  it('reads the file from its last argument and answers every operation', () => {
    expect(DOCUMENT_PROBE_SCRIPT).toContain('OP, O, SRC = A[1], json.loads(A[2] or \'{}\'), A[3]');
    for (const operation of ['pdf-read', 'pdf-view', 'image-view']) {
      expect(DOCUMENT_PROBE_SCRIPT).toContain(`'${operation}'`);
    }
  });

  it('writes no file', () => {
    expect(DOCUMENT_PROBE_SCRIPT).not.toMatch(/open\([^)]*['"]w/);
    expect(DOCUMENT_PROBE_SCRIPT).not.toMatch(/\.save\(\s*(?!b\b)/);
  });
});

describe('runDocumentProbe', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  const answer = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });

  it('returns the parsed answer', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":true,"pages":3}'));
    expect(await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, undefined))
      .toEqual({ status: 'ok', value: { ok: true, pages: 3 } });
  });

  it('passes the operation and the options as separate arguments, and the path last', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":true}'));
    await runDocumentProbe('/tmp/a b.pdf', 'pdf-view', { page: 2 }, undefined);
    const [command, payload] = vi.mocked(invoke).mock.calls[0] as [string, { program: string; args: string[]; timeout: number }];
    expect(command).toBe('run_argv_command');
    expect(payload.args).toEqual(['-c', DOCUMENT_PROBE_SCRIPT, 'pdf-view', '{"page":2}', '/tmp/a b.pdf']);
    expect(payload.timeout).toBe(30);
  });

  it('hands the file to the host processor as its own argument when the operation owns file access', async () => {
    const runProcessor = vi.fn().mockResolvedValue(answer('{"ok":true}'));
    const stat = vi.fn().mockResolvedValue({ size: 1024 });
    const context = { files: { runProcessor, stat } as unknown as ToolFileAccess } as ToolExecutionContext;
    await runDocumentProbe('/tmp/a.png', 'image-view', { rotate: 90 }, context);
    expect(runProcessor).toHaveBeenCalledWith('/tmp/a.png', 'python3', ['-c', DOCUMENT_PROBE_SCRIPT, 'image-view', '{"rotate":90}', null]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports what the program said about the file', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":false,"error":"ValueError","message":"page 9 does not exist"}'));
    expect(await runDocumentProbe('/tmp/a.pdf', 'pdf-view', {}, undefined))
      .toEqual({ status: 'failed', error: 'ValueError', message: 'page 9 does not exist' });
  });

  it('tells a missing interpreter or library apart from a crash', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(answer('', 127, 'python3: command not found'));
    expect((await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, undefined)).status).toBe('unavailable');

    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":false,"error":"ModuleNotFoundError","message":"No module named pypdfium2"}'));
    expect((await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, undefined)).status).toBe('unavailable');

    vi.mocked(invoke).mockResolvedValueOnce(answer('', -1, 'Segmentation fault'));
    expect(await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, undefined))
      .toEqual({ status: 'crashed', detail: 'Segmentation fault' });

    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":true,"list":[\n[truncated: output too large]'));
    expect(await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, undefined))
      .toEqual({ status: 'crashed', detail: 'output too large' });
  });

  it('says a file over the processor\'s input limit is too large, before starting anything', async () => {
    const runProcessor = vi.fn();
    const stat = vi.fn().mockResolvedValue({ size: PROCESSOR_MAX_INPUT_BYTES + 3 * 1024 * 1024 });
    const context = { files: { runProcessor, stat } as unknown as ToolFileAccess } as ToolExecutionContext;
    expect(await runDocumentProbe('/tmp/scan.pdf', 'pdf-read', {}, context))
      .toEqual({ status: 'tooLarge', bytes: PROCESSOR_MAX_INPUT_BYTES + 3 * 1024 * 1024, limit: PROCESSOR_MAX_INPUT_BYTES });
    expect(runProcessor).not.toHaveBeenCalled();
    expect(tooLargeError('scan.pdf', 70_254_592, PROCESSOR_MAX_INPUT_BYTES))
      .toBe('Error: scan.pdf is too large for the document reader (67 MB; the limit is 64 MB). A smaller copy can be read: fewer pages, or scanned at a lower resolution.');
  });

  it('keeps the user\'s folders out of what it says went wrong', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(answer('', 1, 'Traceback (most recent call last):\n  File "/Users/zhangsan/Library/阿布/python/lib/site.py", line 3\nRuntimeError: boom in /Users/zhangsan/Desktop/a.pdf'));
    const crashed = await runDocumentProbe('/Users/zhangsan/Desktop/a.pdf', 'pdf-read', {}, undefined);
    expect(crashed.status).toBe('crashed');
    expect(JSON.stringify(crashed)).not.toContain('zhangsan');
    vi.mocked(invoke).mockResolvedValueOnce(answer('{"ok":false,"error":"UnidentifiedImageError","message":"cannot identify image file \'C:\\\\Users\\\\张三\\\\a.png\'"}'));
    expect(JSON.stringify(await runDocumentProbe('C:\\Users\\张三\\a.png', 'image-view', {}, undefined))).not.toContain('张三');
  });

  it('reports an abort that happened while the program ran', async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementationOnce(async () => {
      controller.abort();
      return answer('', -1, '[Command aborted]');
    });
    expect(await runDocumentProbe('/tmp/a.pdf', 'pdf-read', {}, { abortSignal: controller.signal }))
      .toEqual({ status: 'aborted' });
  });
});

describe('cleanProbeDetail', () => {
  it('says which library is missing, or that Python was not found, without the folders it was looked for in', () => {
    expect(cleanProbeDetail("No module named 'pypdfium2'")).toBe('the Python library "pypdfium2" is missing');
    expect(cleanProbeDetail('No module named PIL.Image')).toBe('the Python library "PIL" is missing');
    expect(cleanProbeDetail('python3: command not found')).toBe('Python was not found');
    expect(cleanProbeDetail('/Users/zhangsan/Library/Application Support/阿布/python/bin/python3: No such file or directory')).toBe('Python was not found');
    expect(cleanProbeDetail("'python' is not recognized as an internal or external command,")).toBe('Python was not found');
    expect(cleanProbeDetail('spawn /Users/zhangsan/.abu/python3 ENOENT')).toBe('Python was not found');
  });

  it('redacts the paths of any other message and keeps the rest', () => {
    expect(cleanProbeDetail('Failed to load document (PDFium: Data format error).')).toBe('Failed to load document (PDFium: Data format error).');
    const redacted = cleanProbeDetail('FileNotFoundError: [Errno 2] No such file or directory: /home/zhangsan/a.pdf');
    expect(redacted).not.toContain('zhangsan');
    expect(redacted).toContain('FileNotFoundError');
  });
});
