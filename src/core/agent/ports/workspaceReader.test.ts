import { describe, it, expect, afterEach } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import {
  createInProcessWorkspaceReader,
  getWorkspaceReader,
  setWorkspaceReader,
  type WorkspaceReader,
} from './workspaceReader';

describe('createInProcessWorkspaceReader', () => {
  afterEach(() => {
    useWorkspaceStore.setState({ currentPath: null });
  });

  it('getCurrentPath() returns the live workspaceStore currentPath', () => {
    useWorkspaceStore.setState({ currentPath: '/tmp/workspace-a' });
    const reader = createInProcessWorkspaceReader();
    expect(reader.getCurrentPath()).toBe('/tmp/workspace-a');
  });

  it('getCurrentPath() returns null when no workspace is bound', () => {
    useWorkspaceStore.setState({ currentPath: null });
    const reader = createInProcessWorkspaceReader();
    expect(reader.getCurrentPath()).toBeNull();
  });

  it('reflects store updates on the next call (not cached at construction time)', () => {
    const reader = createInProcessWorkspaceReader();
    expect(reader.getCurrentPath()).toBeNull();
    useWorkspaceStore.setState({ currentPath: '/tmp/workspace-b' });
    expect(reader.getCurrentPath()).toBe('/tmp/workspace-b');
  });
});

describe('getWorkspaceReader / setWorkspaceReader', () => {
  const defaultReader = getWorkspaceReader();

  afterEach(() => {
    // restore the default in-process reader so other test files aren't affected
    setWorkspaceReader(defaultReader);
  });

  it('getWorkspaceReader() returns a working in-process reader by default', () => {
    const reader = getWorkspaceReader();
    expect(typeof reader.getCurrentPath).toBe('function');
  });

  it('setWorkspaceReader() swaps the module-level reader returned by getWorkspaceReader()', () => {
    const stub: WorkspaceReader = {
      getCurrentPath: () => '/stub/path',
    };
    setWorkspaceReader(stub);
    expect(getWorkspaceReader()).toBe(stub);
    expect(getWorkspaceReader().getCurrentPath()).toBe('/stub/path');
  });
});
