import { describe, it, expect, vi } from 'vitest';

vi.mock('@/core/tools/fsBridge', () => ({
  exists: vi.fn(async (path: string) => path.endsWith('present.md')),
}));

import { findMissingExpectedFiles, parseExpectedFiles, resolveExpectedFile } from './expectedFiles';

describe('expectedFiles (define done before dispatching)', () => {
  it('parses model input defensively', () => {
    expect(parseExpectedFiles(undefined)).toEqual([]);
    expect(parseExpectedFiles('a.md')).toEqual([]);
    expect(parseExpectedFiles([' a.md ', 'a.md', 3, '', 'b/c.md'])).toEqual(['a.md', 'b/c.md']);
    expect(parseExpectedFiles(Array.from({ length: 30 }, (_, i) => `f${i}`))).toHaveLength(20);
  });

  it('resolves relative paths against the workspace and leaves absolute ones alone', () => {
    expect(resolveExpectedFile('out/report.md', '/ws/')).toBe('/ws/out/report.md');
    expect(resolveExpectedFile('/abs/report.md', '/ws')).toBe('/abs/report.md');
    expect(resolveExpectedFile('C:\\abs\\r.md', 'D:\\ws')).toBe('C:\\abs\\r.md');
    expect(resolveExpectedFile('out\\r.md', 'D:\\ws\\')).toBe('D:\\ws\\out\\r.md');
    expect(resolveExpectedFile('out/report.md', null)).toBe('out/report.md');
  });

  it('reports the resolved paths that do not exist', async () => {
    await expect(findMissingExpectedFiles(['present.md', 'missing.md', '/abs/gone.md'], '/ws')).resolves.toEqual(['/ws/missing.md', '/abs/gone.md']);
    await expect(findMissingExpectedFiles([], '/ws')).resolves.toEqual([]);
  });
});
