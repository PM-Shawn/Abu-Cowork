import { describe, it, expect, vi, afterEach } from 'vitest';

const getAuthorizedWritablePathsMock = vi.fn();
vi.mock('../../tools/pathSafety', () => ({
  getAuthorizedWritablePaths: (...a: unknown[]) => getAuthorizedWritablePathsMock(...a),
}));

import {
  createInProcessAuthorizedPathsReader,
  getAuthorizedPathsReader,
  setAuthorizedPathsReader,
  type AuthorizedPathsReader,
} from './authorizedPathsReader';

describe('createInProcessAuthorizedPathsReader', () => {
  afterEach(() => {
    getAuthorizedWritablePathsMock.mockReset();
  });

  it('getAuthorizedWritablePaths() resolves to whatever pathSafety.getAuthorizedWritablePaths() returns', async () => {
    getAuthorizedWritablePathsMock.mockReturnValue(['/tmp/authorized-a', '/tmp/authorized-b']);
    const reader = createInProcessAuthorizedPathsReader();
    await expect(reader.getAuthorizedWritablePaths()).resolves.toEqual(['/tmp/authorized-a', '/tmp/authorized-b']);
  });

  it('getAuthorizedWritablePaths() resolves to an empty array when nothing is authorized', async () => {
    getAuthorizedWritablePathsMock.mockReturnValue([]);
    const reader = createInProcessAuthorizedPathsReader();
    await expect(reader.getAuthorizedWritablePaths()).resolves.toEqual([]);
  });

  it('re-reads pathSafety at call time (not cached at construction time)', async () => {
    getAuthorizedWritablePathsMock.mockReturnValue(['/tmp/first']);
    const reader = createInProcessAuthorizedPathsReader();
    await expect(reader.getAuthorizedWritablePaths()).resolves.toEqual(['/tmp/first']);
    getAuthorizedWritablePathsMock.mockReturnValue(['/tmp/second']);
    await expect(reader.getAuthorizedWritablePaths()).resolves.toEqual(['/tmp/second']);
  });
});

describe('getAuthorizedPathsReader / setAuthorizedPathsReader', () => {
  const defaultReader = getAuthorizedPathsReader();

  afterEach(() => {
    // restore the default in-process reader so other test files aren't affected
    setAuthorizedPathsReader(defaultReader);
  });

  it('getAuthorizedPathsReader() returns a working in-process reader by default', () => {
    const reader = getAuthorizedPathsReader();
    expect(typeof reader.getAuthorizedWritablePaths).toBe('function');
  });

  it('setAuthorizedPathsReader() swaps the module-level reader returned by getAuthorizedPathsReader()', async () => {
    const stub: AuthorizedPathsReader = {
      getAuthorizedWritablePaths: async () => ['/stub/path'],
    };
    setAuthorizedPathsReader(stub);
    expect(getAuthorizedPathsReader()).toBe(stub);
    await expect(getAuthorizedPathsReader().getAuthorizedWritablePaths()).resolves.toEqual(['/stub/path']);
  });
});
