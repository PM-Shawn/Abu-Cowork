import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { searchFilesTool } from './fileTools';
import { setPlatformForTest } from '../../../test/helpers';

describe('search_files on Windows — hits keep an explicit absolute path', () => {
  const abort = { abortSignal: new AbortController().signal };
  let restorePlatform: () => void;

  beforeAll(() => {
    restorePlatform = setPlatformForTest('windows');
    // The home directory is cached on first use, so it is pinned before any check runs.
    vi.mocked(homeDir).mockResolvedValue('C:\\Users\\testuser');
  });
  afterAll(() => {
    restorePlatform();
    vi.mocked(homeDir).mockResolvedValue('/Users/testuser');
  });
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  function sentCommand(): string {
    const call = vi.mocked(invoke).mock.calls.find(([name]) => name === 'run_shell_command');
    return String((call?.[1] as { command: string }).command);
  }

  // Select-String's default text output prints a path relative to the shell's
  // current directory when the file is under it (`review-fixture\\allowed.txt:1:...`),
  // which no safety check can resolve. The command therefore builds each line
  // from the match object's own full Path, never from the default text.
  it('builds every result line from Path, LineNumber and Line, not from the default output', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });
    await searchFilesTool.execute({ pattern: 'REVIEW_ONLY', path: 'C:\\Users\\testuser\\review-fixture' }, abort);
    const command = sentCommand();
    expect(command).toContain('Select-String');
    expect(command).toContain("Select-Object -First 50 | ForEach-Object { '{0}:{1}:{2}' -f $_.Path, $_.LineNumber, $_.Line }");
  });

  it('keeps a normal hit that carries its absolute path and drops a credential file', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      code: 0,
      stdout: [
        'C:\\Users\\testuser\\review-fixture\\allowed.txt:1:REVIEW_ONLY_VISIBLE',
        'C:\\Users\\testuser\\.ssh\\config:2:REVIEW_ONLY_SECRET',
        'C:\\Users\\testuser\\review-fixture\\sub dir\\notes.md:12:REVIEW_ONLY: colon in the text',
      ].join('\r\n'),
      stderr: '',
    });
    const result = String(await searchFilesTool.execute({ pattern: 'REVIEW_ONLY', path: 'C:\\Users\\testuser\\review-fixture' }, abort));
    expect(result).toContain('Found 2 matches');
    expect(result).toContain('allowed.txt:1:REVIEW_ONLY_VISIBLE');
    expect(result).toContain('sub dir\\notes.md:12:REVIEW_ONLY: colon in the text');
    expect(result).not.toContain('.ssh');
  });

  it('still fails closed on a line whose path is not absolute', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      code: 0,
      stdout: 'review-fixture\\allowed.txt:1:REVIEW_ONLY_VISIBLE\n',
      stderr: '',
    });
    const result = String(await searchFilesTool.execute({ pattern: 'REVIEW_ONLY', path: 'C:\\Users\\testuser\\review-fixture' }, abort));
    expect(result).toBe('No matches found.');
  });
});
