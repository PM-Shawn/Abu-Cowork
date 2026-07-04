import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readFileTool } from './fileTools';

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

describe('readFileTool — PDF shell injection regression', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('pdftotext strategy: dispatches run_argv_command with filePath as a raw argv element', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      code: 0,
      stdout: 'extracted text',
      stderr: '',
    });

    const result = await readFileTool.execute({ path: EVIL_PDF_QUOTE });

    expect(result).toBe('extracted text');
    expect(invoke).toHaveBeenCalledTimes(1);

    const [cmdName, payload] = firstCall();
    expect(cmdName).toBe('run_argv_command');
    expect(payload.program).toBe('pdftotext');
    // Critical: the evil path is the first argv element, unescaped, untouched.
    expect(payload.args).toEqual([EVIL_PDF_QUOTE, '-']);
  });

  it('falls back to pdfplumber when pdftotext fails — still argv, still verbatim', async () => {
    // Strategy 1 (pdftotext) returns empty stdout → strategy 2 (pdfplumber) fires
    vi.mocked(invoke)
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'pdftotext not installed' })
      .mockResolvedValueOnce({ code: 0, stdout: 'plumber text', stderr: '' });

    const result = await readFileTool.execute({ path: EVIL_PDF_DOLLAR });

    expect(result).toBe('plumber text');
    expect(invoke).toHaveBeenCalledTimes(2);

    // First call: pdftotext with argv
    const [cmd1, payload1] = firstCall();
    expect(cmd1).toBe('run_argv_command');
    expect(payload1.program).toBe('pdftotext');
    expect(payload1.args).toEqual([EVIL_PDF_DOLLAR, '-']);

    // Second call: python3 with pdfplumber, file path is sys.argv[1]
    const [cmd2, payload2] = nthCall(1);
    expect(cmd2).toBe('run_argv_command');
    expect(payload2.program).toBe('python3');
    expect(payload2.args[0]).toBe('-c');
    // The Python source is the second element — it must NOT contain the
    // file path (that would mean string interpolation is back)
    expect(payload2.args[1]).not.toContain(EVIL_PDF_DOLLAR);
    expect(payload2.args[1]).not.toContain('$(');
    expect(payload2.args[1]).toContain('sys.argv[1]');
    // File path must be passed as a separate argv element
    expect(payload2.args[2]).toBe(EVIL_PDF_DOLLAR);
  });

  it('never dispatches run_shell_command when reading a PDF', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: 'x', stderr: '' });
    await readFileTool.execute({ path: EVIL_PDF_BACKTICK });

    const shellCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === 'run_shell_command');
    expect(shellCalls).toHaveLength(0);
  });

  it('PDFPLUMBER_SCRIPT does not contain any shell metacharacter interpolation', async () => {
    // Observe the script by triggering the fallback branch
    vi.mocked(invoke)
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    await readFileTool.execute({ path: '/tmp/benign.pdf' });

    const [, payload] = nthCall(1);
    const script = payload.args[1];
    // Defensive: script must not contain template-literal escape holes
    expect(script).not.toContain('${');
    expect(script).not.toContain('$(');
    expect(script).not.toMatch(/`[^`]*`/);
    // Script must actually read from argv
    expect(script).toContain('sys.argv[1]');
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
  });

  it('returns a text note (no image block) when supportsVision is false', async () => {
    const result = await readFileTool.execute({ path: '/tmp/图片.png' }, { supportsVision: false });
    expect(typeof result).toBe('string');
    expect(result as string).toContain('/tmp/图片.png');
    expect(result as string).toContain('无视觉能力');
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
    expect(String(result)).not.toContain('无视觉能力');
  });
});
