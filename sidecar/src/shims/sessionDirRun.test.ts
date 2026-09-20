/**
 * The sidecar's session output directory, on real files.
 *
 * This shim is the only place in the sidecar that turns an `agent.start`
 * conversation id into a directory it then creates recursively, and
 * `agentLoopHost.ts` checks that id for nothing but "non-empty string". So the
 * case that matters is the traversal-shaped one: the conversation-id grammar
 * has to refuse it before `mkdir` runs, and nothing may appear outside the
 * conversations root.
 *
 * Each test imports the module after `vi.resetModules()`: the shim resolves its
 * app data directory once and caches it, so a fresh module per test is what
 * makes that test's own temp directory take effect. That reset also gives the
 * shim its own copy of `conversationPaths`, so the rejection is matched on the
 * error's `code` and `reason` rather than on class identity.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const invalidId = { name: 'ConversationIdError', code: 'conversation_id_invalid' };

const root = { path: '' };
vi.mock('./tauriPathRun', () => ({ appDataDir: async () => root.path }));

describe('sidecar getSessionOutputDir', () => {
  beforeEach(async () => {
    root.path = await mkdtemp(join(tmpdir(), 'abu-shim-session-dir-'));
    vi.resetModules();
  });
  afterEach(async () => {
    await rm(root.path, { recursive: true, force: true });
    await rm(join(root.path, '..', 'abu-shim-session-dir-escape-probe'), { recursive: true, force: true });
  });

  it('creates the conversation outputs directory', async () => {
    const { getSessionOutputDir } = await import('./sessionDirRun');
    const dir = await getSessionOutputDir('conv-1');
    expect(dir).toBe(`${root.path.replace(/\\/g, '/')}/conversations/conv-1/outputs`);
    expect((await stat(dir!)).isDirectory()).toBe(true);
  });

  it('refuses a traversal id and creates nothing outside the root', async () => {
    const { getSessionOutputDir } = await import('./sessionDirRun');
    const escaped = join(root.path, '..', 'abu-shim-session-dir-escape-probe');
    await expect(stat(escaped)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(getSessionOutputDir('../abu-shim-session-dir-escape-probe'))
      .rejects.toMatchObject({ ...invalidId, reason: 'charset' });

    await expect(stat(escaped)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root.path, 'conversations'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses every other id the conversation grammar rejects', async () => {
    const { getSessionOutputDir } = await import('./sessionDirRun');
    for (const bad of ['', 'a/b', 'a\\b', 'a..b', 'CON', 'abc.', 'index.json']) {
      await expect(getSessionOutputDir(bad)).rejects.toMatchObject(invalidId);
    }
    await expect(stat(join(root.path, 'conversations'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
