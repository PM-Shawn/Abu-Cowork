import { describe, it, expect, afterEach } from 'vitest';
import { useScratchpadStore } from '@/stores/scratchpadStore';
import {
  createInProcessScratchpadPort,
  getScratchpadPort,
  setScratchpadPort,
  type ScratchpadPort,
} from './scratchpadPort';

describe('createInProcessScratchpadPort', () => {
  afterEach(() => {
    useScratchpadStore.setState({ entries: {}, order: [] });
  });

  it('addEntry() creates an entry in scratchpadStore and returns its id', () => {
    const port = createInProcessScratchpadPort();
    const id = port.addEntry({
      conversationId: 'conv-1',
      title: 'test extraction',
      type: 'extraction',
      content: 'hello world',
    });
    expect(typeof id).toBe('string');
    expect(useScratchpadStore.getState().entries[id]).toMatchObject({
      conversationId: 'conv-1',
      title: 'test extraction',
      type: 'extraction',
      content: 'hello world',
    });
  });

  it('reflects store reads made after the port call (not cached)', () => {
    const port = createInProcessScratchpadPort();
    expect(Object.keys(useScratchpadStore.getState().entries)).toHaveLength(0);
    port.addEntry({ conversationId: 'conv-1', title: 't', type: 'summary', content: 'c' });
    expect(Object.keys(useScratchpadStore.getState().entries)).toHaveLength(1);
  });
});

describe('getScratchpadPort / setScratchpadPort', () => {
  const defaultPort = getScratchpadPort();

  afterEach(() => {
    // restore the default in-process port so other test files aren't affected
    setScratchpadPort(defaultPort);
  });

  it('getScratchpadPort() returns a working in-process port by default', () => {
    const port = getScratchpadPort();
    expect(typeof port.addEntry).toBe('function');
  });

  it('setScratchpadPort() swaps the module-level port returned by getScratchpadPort()', () => {
    const stub: ScratchpadPort = {
      addEntry: () => 'stub-id',
    };
    setScratchpadPort(stub);
    expect(getScratchpadPort()).toBe(stub);
    expect(getScratchpadPort().addEntry({ conversationId: 'c', title: 't', type: 'summary', content: 'x' })).toBe('stub-id');
  });
});
