import { afterEach, describe, expect, it, vi } from 'vitest';
import { rendererConversationFs } from './conversationFsRenderer';

type Bridge = { canonicalizePathForPolicy?: (path: string, followFinalSymlink?: boolean) => Promise<string> };
const runtime = globalThis as typeof globalThis & { __ABU_SHELL__?: Bridge };

afterEach(() => {
  delete runtime.__ABU_SHELL__;
});

describe('rendererConversationFs.canonicalPath', () => {
  it('answers null when the Electron bridge is absent, so the tier has no canonical primitive', async () => {
    expect(runtime.__ABU_SHELL__).toBeUndefined();
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).resolves.toBeNull();
  });

  it('asks main to follow the final component, so a linked conversation directory answers where it points', async () => {
    const canonicalizePathForPolicy = vi.fn(async () => '/Volumes/elsewhere/c1');
    runtime.__ABU_SHELL__ = { canonicalizePathForPolicy };
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).resolves.toBe('/Volumes/elsewhere/c1');
    expect(canonicalizePathForPolicy).toHaveBeenCalledWith('/data/abu/conversations/c1', true);
  });

  it('lets a bridge rejection through, because a path that cannot be resolved is not a path that is contained', async () => {
    runtime.__ABU_SHELL__ = {
      canonicalizePathForPolicy: async () => { throw new Error('ELOOP'); },
    };
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).rejects.toThrow('ELOOP');
  });
});
