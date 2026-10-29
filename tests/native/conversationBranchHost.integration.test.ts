import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { conversationBranchPrefix } from '../../src/core/session/conversationBranchProtocol';
import { sanitizeLoadedLedgerMessages } from '../../src/core/session/loadedMessageSanitizer';
import type { Message } from '../../src/types';

const require_ = createRequire(import.meta.url);
const { createConversationBranchHost } = require_('../../electron/conversationBranchHost.cjs');
const native = require_('../../electron/nativeHelperManager.cjs');
let root: string;
let sequence: number;
let dispatch: ReturnType<typeof createConversationBranchHost>;
const identity = { sourceConversationId: 'source', targetMessageId: 'answer', childConversationId: 'child' };
const receipt = `child.${crypto.createHash('sha256').update(JSON.stringify(['source', 'answer'])).digest('hex')}.operation`;
const messages: Message[] = [
  { id: 'user', role: 'user', content: 'Question', timestamp: 1, runState: 'completed' },
  { id: 'answer', role: 'assistant', content: 'Answer', timestamp: 2, streamEnded: true },
];
const sourceMeta = { id: 'source', title: 'Source', createdAt: 1, updatedAt: 2, messageCount: 2, workspacePath: '/work',
  enabledMCPServers: ['server'], goal: { objective: 'Source only' }, scheduledTaskId: 'scheduled', model: { providerId: 'provider', modelId: 'model' } };
async function put(relative: string, text: string) {
  const filename = path.join(root, relative);
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  await fs.promises.writeFile(filename, text);
}
function host() { return createConversationBranchHost({ appDataDir: root, now: () => 100, createId: () => `generated-${++sequence}` }); }
async function request() {
  return { ...identity, watermark: (await fs.promises.stat(path.join(root, 'conversations/source/messages.jsonl'))).size,
    prefix: conversationBranchPrefix(messages, 'source', 'answer', () => null), title: 'Source · Branch', errorEmptyBody: '' };
}
async function commit() {
  const prepared = await dispatch('prepare', await request());
  return dispatch('commit', { ...identity, token: prepared.token });
}
beforeEach(async () => {
  const parent = path.resolve('.agent/branch-host-tests');
  await fs.promises.mkdir(parent, { recursive: true });
  root = await fs.promises.mkdtemp(path.join(parent, 'case-'));
  sequence = 0;
  await put('conversations/source/messages.jsonl', messages.map(message => JSON.stringify(message) + '\n').join(''));
  await put('conversations/index.json', JSON.stringify({ version: 1, entries: { source: sourceMeta } }));
  dispatch = host();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});
afterAll(() => native.killNativeHelper('branch-host-tests-finished'));

describe('branch transaction with real native file operations', () => {
  it('uses the production ID generator for messages, loops and the operation token', async () => {
    dispatch = createConversationBranchHost({ appDataDir: root, now: () => 100 });
    const result = await commit();
    expect(result.state).toBe('committed');
    expect(result.meta.branchOrigin.inheritedThroughMessageId).toEqual(expect.any(String));
    expect(result.meta.branchOrigin.inheritedThroughMessageId).not.toBe('answer');
  });
  it('accepts the real reader projection after reopening completed history', async () => {
    const reloaded = sanitizeLoadedLedgerMessages(messages, { text: { errorEmptyBody: '' } });
    const input = { ...await request(), prefix: conversationBranchPrefix(reloaded, 'source', 'answer', () => null) };
    const prepared = await dispatch('prepare', input);
    expect((await dispatch('commit', { ...identity, token: prepared.token })).state).toBe('committed');
  });
  it('accepts recovered legacy tool flags while rejecting a current running user turn', async () => {
    const legacy: Message[] = [
      { ...messages[0], runState: undefined },
      { ...messages[1], streamEnded: undefined, toolCalls: [{ id: 'old-tool', name: 'write_file', input: {}, isExecuting: true }] },
    ];
    await put('conversations/source/messages.jsonl', legacy.map(message => JSON.stringify(message) + '\n').join(''));
    const reloaded = sanitizeLoadedLedgerMessages(legacy, { text: { errorEmptyBody: '' } });
    const input = { ...await request(), prefix: conversationBranchPrefix(reloaded, 'source', 'answer', () => null) };
    const prepared = await dispatch('prepare', input);
    expect((await dispatch('commit', { ...identity, token: prepared.token })).state).toBe('committed');
    const saved = await fs.promises.readFile(path.join(root, 'conversations/child/messages.jsonl'), 'utf8');
    expect(saved).toContain('Its outcome is unknown');
    const active = [{ ...legacy[0], runState: 'running' }, legacy[1]];
    await put('conversations/source/messages.jsonl', active.map(message => JSON.stringify(message) + '\n').join(''));
    await expect(dispatch('prepare', { ...input, childConversationId: 'active-child',
      watermark: (await fs.promises.stat(path.join(root, 'conversations/source/messages.jsonl'))).size,
    })).rejects.toThrow('incomplete');
  });
  it('commits complete history, waits for the index, then publishes exactly once', async () => {
    const result = await commit();
    expect(result.state).toBe('committed');
    expect(result.meta).toMatchObject({ id: 'child', messageCount: 2, workspacePath: '/work', enabledMCPServers: ['server'], model: sourceMeta.model });
    expect(result.meta.goal).toBeUndefined();
    expect(result.meta.scheduledTaskId).toBeUndefined();
    expect(await dispatch('pending')).toEqual(['child']);
    await expect(dispatch('publish', identity)).rejects.toThrow('index-not-saved');
    await put('conversations/index.json', JSON.stringify({ version: 1, entries: { source: sourceMeta, child: result.meta } }));
    expect(await dispatch('publish', identity)).toEqual({ ...result, state: 'published' });
    expect(await dispatch('pending')).toEqual([]);
    expect(await dispatch('publish', identity)).toEqual({ ...result, state: 'published' });
    const history = await fs.promises.readFile(path.join(root, 'conversations/child/messages.jsonl'), 'utf8');
    expect(history).toContain('Question');
    expect(history).toContain('Answer');
    expect(history).not.toContain('"id":"answer"');
  });

  it('shares one prepared identity and one committed result across repeated requests', async () => {
    const input = await request();
    const [first, second] = await Promise.all([dispatch('prepare', input), dispatch('prepare', input)]);
    expect(first).toEqual(second);
    const inputCommit = { ...identity, token: first.token };
    const [a, b] = await Promise.all([dispatch('commit', inputCommit), dispatch('commit', inputCommit)]);
    expect(a).toEqual(b);
    expect((await fs.promises.readdir(path.join(root, 'conversations'))).filter(name => name === 'child')).toHaveLength(1);
  });

  it('inherits the selected app environment and leaves active work with the source', async () => {
    const appBinding = { version: 2, appId: 'app', appVersion: '1.0', origin: 'created', appName: 'Selected app',
      modeId: 'mode', sceneId: 'scene', run: { team: 'mine:team', skill: 'mine:report' }, promptAppend: 'Selected app instructions' };
    await put('conversations/index.json', JSON.stringify({ version: 1, entries: { source: { ...sourceMeta,
      appBinding, teamId: 'team', projectId: 'project', permissionMode: 'standard', readOnly: true,
      activeSkills: ['one-turn'], activeSkillArgs: 'temporary', triggerId: 'trigger', imChannelId: 'channel',
      runId: 'active-run', clientMessageId: 'request',
    } } }));
    const result = await commit();
    expect(result.meta).toMatchObject({ appBinding, teamId: 'team', projectId: 'project', permissionMode: 'standard',
      readOnly: true, model: sourceMeta.model, enabledMCPServers: sourceMeta.enabledMCPServers });
    for (const field of ['activeSkills', 'activeSkillArgs', 'triggerId', 'imChannelId', 'runId', 'clientMessageId', 'goal', 'scheduledTaskId']) {
      expect(result.meta).not.toHaveProperty(field);
    }
  });

  it('recovers a committed branch after restart and source deletion', async () => {
    const result = await commit();
    await fs.promises.rm(path.join(root, 'conversations/source'), { recursive: true });
    await put('conversations/index.json', JSON.stringify({ version: 1, entries: {} }));
    dispatch = host();
    expect(await dispatch('lookup', identity)).toEqual(result);
    expect(await dispatch('recover', { childConversationId: 'child' })).toEqual(result);
    await put('conversations/index.json', JSON.stringify({ version: 1, entries: { child: result.meta } }));
    expect((await dispatch('publish', identity)).state).toBe('published');
  });

  it('does not recreate a published branch deleted by the user through an old retry', async () => {
    const result = await commit();
    await put('conversations/index.json', JSON.stringify({ version: 1, entries: { child: result.meta } }));
    await dispatch('publish', identity);
    await fs.promises.rm(path.join(root, 'conversations/child'), { recursive: true });
    await expect(dispatch('lookup', identity)).rejects.toThrow('branch-deleted');
    await expect(dispatch('prepare', await request())).rejects.toThrow('branch-deleted');
  });

  it('uses the selected prefix while later turns continue to append', async () => {
    const input = await request();
    await fs.promises.appendFile(path.join(root, 'conversations/source/messages.jsonl'), JSON.stringify({ id: 'later', role: 'user', content: 'Later', timestamp: 3 }) + '\n');
    const prepared = await dispatch('prepare', input);
    const result = await dispatch('commit', { ...identity, token: prepared.token });
    expect(result.meta.messageCount).toBe(2);
    expect(await fs.promises.readFile(path.join(root, 'conversations/child/messages.jsonl'), 'utf8')).not.toContain('Later');
  });

  it('rejects source changes, corrupt lines and invalid byte boundaries', async () => {
    const input = await request();
    await expect(dispatch('prepare', { ...input, prefix: input.prefix.replace('Answer', 'Edited') })).rejects.toThrow('source-changed');
    await expect(dispatch('prepare', { ...input, watermark: input.watermark - 1 })).rejects.toThrow();
    await fs.promises.appendFile(path.join(root, 'conversations/source/messages.jsonl'), '{invalid}\n');
    await expect(dispatch('prepare', await request())).rejects.toThrow('invalid-history');
  });

  it('refuses foreign destination directories and forged operation tokens', async () => {
    const prepared = await dispatch('prepare', await request());
    await expect(dispatch('commit', { ...identity, token: 'wrong' })).rejects.toThrow('preparation-unavailable');
    await put('conversations/child/foreign', 'Keep');
    await expect(dispatch('commit', { ...identity, token: prepared.token })).rejects.toThrow('identity-conflict');
    expect(await fs.promises.readFile(path.join(root, 'conversations/child/foreign'), 'utf8')).toBe('Keep');
  });

  it('removes only the interrupted staging directory before a fresh attempt', async () => {
    await put(`conversation-branches/${receipt}`, '');
    await put('conversation-branches/child/outputs/stale.txt', 'Partial');
    await put('conversation-branches/other/keep.txt', 'Keep');
    expect((await commit()).state).toBe('committed');
    expect(await fs.promises.readFile(path.join(root, 'conversation-branches/other/keep.txt'), 'utf8')).toBe('Keep');
    expect(fs.existsSync(path.join(root, 'conversations/child/outputs/stale.txt'))).toBe(false);
  });

  it('keeps a different operation in staging intact after restart', async () => {
    const other = crypto.createHash('sha256').update(JSON.stringify(['another-source', 'another-answer'])).digest('hex');
    await put(`conversation-branches/child.${other}.operation`, '');
    await put('conversation-branches/child/keep.txt', 'Keep');
    await expect(commit()).rejects.toThrow('identity-conflict');
    expect(await fs.promises.readFile(path.join(root, 'conversation-branches/child/keep.txt'), 'utf8')).toBe('Keep');
  });

  it('retries the same operation after interruption during its first staged file', async () => {
    await put(`conversation-branches/${receipt}`, '');
    await put('conversation-branches/child/messages.jsonl', '{partial');
    dispatch = host();
    expect((await commit()).state).toBe('committed');
  });

  it('cleans abandoned preparations before capacity checks for a new operation', async () => {
    await put('conversations/source/results/capacity.dat', '');
    await fs.promises.truncate(path.join(root, 'conversations/source/results/capacity.dat'), 5 * 1024 * 1024 * 1024 - 1024);
    await put(`conversation-branches/${receipt}`, '');
    await put('conversation-branches/child/results/partial.dat', Buffer.alloc(2048).toString());
    dispatch = host();
    const prepared = await dispatch('prepare', { ...await request(), childConversationId: 'next-child' });
    expect(prepared.state).toBe('prepared');
    expect(fs.existsSync(path.join(root, 'conversation-branches/child'))).toBe(false);
    expect(fs.existsSync(path.join(root, `conversation-branches/${receipt}`))).toBe(false);
    expect(fs.existsSync(path.join(root, 'conversations/source/results/capacity.dat'))).toBe(true);
  });

  it('cleans interrupted preparations at startup and retains active and committed results', async () => {
    await put(`conversation-branches/${receipt}`, '');
    await put('conversation-branches/child/results/partial.txt', 'Partial');
    expect(await dispatch('cleanup')).toEqual([]);
    expect(fs.existsSync(path.join(root, 'conversation-branches/child'))).toBe(false);
    const prepared = await dispatch('prepare', await request());
    await put(`conversation-branches/${receipt}`, '');
    await put('conversation-branches/child/results/active.txt', 'Active');
    expect(await dispatch('cleanup')).toEqual([]);
    expect(fs.existsSync(path.join(root, 'conversation-branches/child/results/active.txt'))).toBe(true);
    await dispatch('commit', { ...identity, token: prepared.token });
    expect(await dispatch('cleanup')).toEqual([]);
    expect((await dispatch('recover', { childConversationId: 'child' })).state).toBe('committed');
  });

  it('isolates a symbolic-link recovery marker from other pending branches', async () => {
    await commit();
    await put('conversations/broken/other.json', '{}');
    await fs.promises.symlink(path.join(root, 'conversations/broken/other.json'), path.join(root, 'conversations/broken/branch-recovery.json'));
    await fs.promises.mkdir(path.join(root, 'conversations/not-an-id.'));
    expect((await dispatch('pending')).sort()).toEqual(['broken', 'child']);
    await expect(dispatch('recover', { childConversationId: 'broken' })).rejects.toThrow('unsafe-file');
    expect((await dispatch('recover', { childConversationId: 'child' })).state).toBe('committed');
  });

  it('keeps a corrupt committed branch pending without disturbing another chat', async () => {
    await commit();
    await fs.promises.appendFile(path.join(root, 'conversations/child/messages.jsonl'), '{}\n');
    dispatch = host();
    expect(await dispatch('pending')).toEqual(['child']);
    await expect(dispatch('recover', { childConversationId: 'child' })).rejects.toThrow('invalid-recovery');
    expect(await fs.promises.readFile(path.join(root, 'conversations/source/messages.jsonl'), 'utf8')).toContain('Answer');
  });

  it('rejects path-bearing requests before creating files', async () => {
    const input = await request();
    await expect(dispatch('prepare', { ...input, childConversationId: '../outside' })).rejects.toThrow();
    await expect(dispatch('prepare', { ...input, sourceDirectory: '/outside' })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'conversation-branches'))).toBe(false);
  });

  it('keeps pending branches out of catalog scans, direct reads, lists and search', async () => {
    const result = await commit();
    const catalog = require_('../../electron/catalogDb.cjs');
    const app = { isPackaged: false, getPath: () => root };
    const catalogRoot = path.join(root, 'com.abu.app.electron-dev/conversations');
    await fs.promises.mkdir(path.dirname(catalogRoot), { recursive: true });
    await fs.promises.cp(path.join(root, 'conversations'), catalogRoot, { recursive: true });
    const db = catalog._internal.getDb(app);
    try {
      const row = { conv_id: 'child', title: result.meta.title, created_at: 100, updated_at: 100, message_count: 2, source_bytes: 1, missing: false };
      catalog._internal.upsertCore(db, row);
      catalog._internal.ftsUpsertCore(db, 'child', result.meta.title, 'Answer', true);
      expect(catalog.catalogDispatch(app, 'catalog_get_conversation', { convId: 'child' })).toBeNull();
      expect(catalog.catalogDispatch(app, 'catalog_list_conversations', {})).toEqual([]);
      expect(catalog.catalogDispatch(app, 'catalog_search', { query: 'Answer' })).toEqual([]);
      expect(catalog._internal.reindexScanCore('child', catalogRoot)).toBeNull();
      const scan = catalog._internal.reconcileScanCore(catalogRoot, new Map(), new Set());
      expect(scan.upserts.some(([entry]: [{ conv_id: string }]) => entry.conv_id === 'child')).toBe(false);
      await fs.promises.unlink(path.join(catalogRoot, 'child/branch-recovery.json'));
      await fs.promises.symlink(path.join(root, 'absent-recovery'), path.join(catalogRoot, 'child/branch-recovery.json'));
      expect(catalog.catalogDispatch(app, 'catalog_search', { query: 'Answer' })).toEqual([]);
      expect(catalog._internal.reindexScanCore('child', catalogRoot)).toBeNull();
      expect(catalog._internal.reconcileScanCore(catalogRoot, new Map(), new Set()).upserts
        .some(([entry]: [{ conv_id: string }]) => entry.conv_id === 'child')).toBe(false);
      await fs.promises.unlink(path.join(catalogRoot, 'child/branch-recovery.json'));
      catalog.catalogDispatch(app, 'catalog_reindex_conversation', { convId: 'child', conversationsRoot: catalogRoot });
      expect(catalog.catalogDispatch(app, 'catalog_get_conversation', { convId: 'child' })).toMatchObject({ conv_id: 'child' });
      expect(catalog.catalogDispatch(app, 'catalog_search', { query: 'Answer' })).toHaveLength(1);
      if (process.platform !== 'win32') {
        await fs.promises.chmod(path.join(catalogRoot, 'child'), 0);
        try {
          expect(catalog.catalogDispatch(app, 'catalog_search', { query: 'Answer' })).toEqual([]);
          expect(catalog._internal.reconcileScanCore(catalogRoot, new Map(), new Set()).upserts
            .some(([entry]: [{ conv_id: string }]) => entry.conv_id === 'source')).toBe(true);
        } finally { await fs.promises.chmod(path.join(catalogRoot, 'child'), 0o700); }
      }
    } finally { db.close(); }
  });
});
