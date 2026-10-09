import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_PRESENTED_FILES, parsePresentedFilesInput, presentFilesTool } from './presentTools';
import type { ToolExecutionContext } from '../../../types';

const mockExists = vi.fn();
const mockStat = vi.fn();
vi.mock('../fsBridge', () => ({
  exists: (p: string) => mockExists(p),
  stat: (p: string) => mockStat(p),
}));

const mockCheckReadPath = vi.fn();
vi.mock('../pathSafety', () => ({
  checkReadPath: (...args: unknown[]) => mockCheckReadPath(...args),
}));

async function run(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const result = await presentFilesTool.execute(input, context);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('presentFilesTool', () => {
  beforeEach(() => {
    mockExists.mockReset().mockResolvedValue(true);
    mockStat.mockReset().mockResolvedValue({ isFile: true, isDirectory: false, size: 1024 });
    mockCheckReadPath.mockReset().mockResolvedValue({ allowed: true });
  });

  describe('execute', () => {
    it('presents every file when all of them exist', async () => {
      const out = await run({ files: [{ path: '/out/report.md' }, { path: '/out/chart.png', description: 'Chart' }] });
      expect(out).toBe('Presented /out/report.md\nPresented /out/chart.png');
      expect(out.startsWith('Error')).toBe(false);
    });

    it('resolves a relative path against the workspace', async () => {
      const out = await run({ files: [{ path: 'report.md' }] }, { workspacePath: '/ws' });
      expect(mockExists).toHaveBeenCalledWith('/ws/report.md');
      expect(out).toBe('Presented /ws/report.md');
    });

    it('rejects a relative path when there is no workspace', async () => {
      const out = await run({ files: [{ path: 'report.md' }] }, {});
      expect(out.startsWith('Error: Nothing was presented.')).toBe(true);
      expect(out).toContain('report.md');
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('rejects a home-relative path', async () => {
      const out = await run({ files: [{ path: '~/report.md' }] }, { workspacePath: '/ws' });
      expect(out.startsWith('Error: Nothing was presented.')).toBe(true);
      expect(out).toContain('~/report.md');
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('lists the missing and the valid paths when one file does not exist', async () => {
      mockExists.mockImplementation(async (p: string) => p !== '/out/missing.md');
      const out = await run({ files: [{ path: '/out/report.md' }, { path: '/out/missing.md' }] });
      expect(out.startsWith('Error:')).toBe(true);
      expect(out).toContain('/out/missing.md');
      expect(out).toContain('These were fine:');
      expect(out).toContain('/out/report.md');
      expect(out).not.toContain('Presented /out/report.md');
      expect(out.endsWith('call present_files again with the full list.')).toBe(true);
    });

    it('rejects a directory', async () => {
      mockStat.mockResolvedValue({ isFile: false, isDirectory: true, size: 0 });
      const out = await run({ files: [{ path: '/out/dir' }] });
      expect(out.startsWith('Error:')).toBe(true);
      expect(out).toContain('/out/dir');
      expect(out).not.toContain('These were fine:');
    });

    it('checks authorization before probing the disk', async () => {
      mockCheckReadPath.mockResolvedValue({ allowed: false });
      const out = await run({ files: [{ path: '/secret/key.pem' }] }, { authorizationScopeId: 'scope-1' });
      expect(out.startsWith('Error:')).toBe(true);
      expect(out).toContain('/secret/key.pem');
      expect(mockCheckReadPath).toHaveBeenCalledWith('/secret/key.pem', 'scope-1');
      expect(mockExists).not.toHaveBeenCalled();
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('rejects an empty list', async () => {
      const out = await run({ files: [] });
      expect(out).toBe('Error: present_files accepts 1 to 8 files.');
      expect(mockCheckReadPath).not.toHaveBeenCalled();
    });

    it('rejects more files than the limit', async () => {
      const files = Array.from({ length: MAX_PRESENTED_FILES + 1 }, (_, i) => ({ path: `/out/${i}.md` }));
      const out = await run({ files });
      expect(out).toBe('Error: present_files accepts 1 to 8 files.');
      expect(mockCheckReadPath).not.toHaveBeenCalled();
    });

    it('accepts exactly the limit', async () => {
      const files = Array.from({ length: MAX_PRESENTED_FILES }, (_, i) => ({ path: `/out/${i}.md` }));
      const out = await run({ files });
      expect(out.split('\n')).toHaveLength(MAX_PRESENTED_FILES);
      expect(out.startsWith('Presented /out/0.md')).toBe(true);
    });
  });

  describe('definition', () => {
    it('is concurrency-safe and caps the list in its schema', () => {
      expect(presentFilesTool.name).toBe('present_files');
      expect(presentFilesTool.isConcurrencySafe).toBe(true);
      expect(presentFilesTool.inputSchema.properties.files.minItems).toBe(1);
      expect(presentFilesTool.inputSchema.properties.files.maxItems).toBe(MAX_PRESENTED_FILES);
      expect(presentFilesTool.inputSchema.required).toEqual(['files']);
    });
  });
});

describe('parsePresentedFilesInput', () => {
  it('drops entries whose path is not a non-blank string', () => {
    expect(parsePresentedFilesInput([
      { path: '/a.md' },
      { path: 42 },
      { path: '   ' },
      { description: 'no path' },
      null,
      'plain string',
    ])).toEqual([{ path: '/a.md' }]);
  });

  it('trims the path and keeps a non-empty description', () => {
    expect(parsePresentedFilesInput([
      { path: '  /a.md  ', description: 'Quarterly report' },
      { path: '/b.md', description: '' },
      { path: '/c.md', description: 7 },
    ])).toEqual([
      { path: '/a.md', description: 'Quarterly report' },
      { path: '/b.md' },
      { path: '/c.md' },
    ]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(parsePresentedFilesInput(undefined)).toEqual([]);
    expect(parsePresentedFilesInput({ path: '/a.md' })).toEqual([]);
  });
});
