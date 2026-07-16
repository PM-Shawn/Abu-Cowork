import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { writeTextFile, readTextFile, exists } from '@tauri-apps/plugin-fs';
import { readFileTool, writeFileTool, deleteFileTool, editFileTool } from './fileTools';
import { registerBuiltinTools } from '../builtins';
import { toolRegistry } from '../registry';
import { TOOL_NAMES } from '../toolNames';

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
