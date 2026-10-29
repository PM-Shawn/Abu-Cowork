import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import type { Message } from '../../src/types';
import type { SnapshotEntry } from '../../src/core/session/outputSnapshots';
import * as shared from '../../src/core/session/conversationBranchShared';

const require_ = createRequire(import.meta.url);
const host = require_('../../electron/conversationBranchFiles.cjs');
const bundled = require_('../../electron/generated/conversationBranch.cjs') as typeof shared;
const native = require_('../../electron/nativeHelperManager.cjs');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF').toString('base64');
let root: string;
const assistant = (extra: Partial<Message> = {}): Message => ({ id: 'child-answer', role: 'assistant', content: 'Answer', timestamp: 2, ...extra });
const call = (relative = 'results/full.txt') => ({ id: 'call', name: 'run_command', input: {}, result: 'Preview', fullResultRef: { relPath: relative } });
const snapshot = (overrides: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  originalPath: '/work/report.txt', basename: 'report.txt', snapshotRelPath: 'files/capture/report.txt',
  size: 8, originalMtime: 1, snapshottedAt: 2, source: 'tool-output', refId: 'call', refKind: 'write_file', captureId: 'capture', ...overrides,
});
async function put(relative: string, bytes: string | Buffer) {
  const filename = path.join(root, relative);
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  await fs.promises.writeFile(filename, bytes);
  return filename;
}
async function prepare(messages: Message[] = [assistant({ toolCalls: [call()] })], childConversationId = 'child') {
  return host.prepareBranchFiles({ appDataDir: root, sourceConversationId: 'source', childConversationId, messages, messageIdMap: new Map([['source-user', 'child-user']]) });
}
async function publish(prepared: Awaited<ReturnType<typeof prepare>>) {
  const checksums = await host.copyBranchFiles(prepared);
  await put(`conversation-branches/${prepared.childConversationId}/outputs/manifest.json`, JSON.stringify(prepared.plan.manifest));
  await fs.promises.rename(path.join(root, 'conversation-branches', prepared.childConversationId), path.join(root, 'conversations', prepared.childConversationId));
  return checksums;
}

beforeEach(async () => {
  const parent = path.resolve('.agent/branch-files-tests');
  await fs.promises.mkdir(parent, { recursive: true });
  root = await fs.promises.mkdtemp(path.join(parent, 'case-'));
  await fs.promises.mkdir(path.join(root, 'conversations/source'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});
afterAll(() => native.killNativeHelper('branch-files-tests-finished'));

describe('branch files through the Electron host and real filesystem', () => {
  it('uses the current shared bundle and the same pure file plan', () => {
    const stdout = execFileSync(process.execPath, ['scripts/gen-conversation-branch.mjs', '--check'], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, TMPDIR: path.resolve('.agent/tmp') } });
    expect(stdout).toContain('is up to date');
    const options = { sourceConversationId: 'source', childConversationId: 'child', sourceDirectory: '/app/conversations/source', childDirectory: '/app/conversations/child', messages: [assistant({ toolCalls: [call()] })], messageIdMap: new Map<string, string>(), entries: [] };
    expect(bundled.buildConversationBranchFilePlan(options)).toEqual(shared.buildConversationBranchFilePlan(options));
  });

  it('copies exact bytes, hashes and independent files; source deletion leaves the child readable', async () => {
    const original = await put('conversations/source/results/full.txt', 'Complete result\n');
    const prepared = await prepare();
    const checksums = await publish(prepared);
    const copied = path.join(root, 'conversations/child/results/branch-1.txt');
    expect(await fs.promises.readFile(copied, 'utf8')).toBe('Complete result\n');
    expect((await fs.promises.stat(original)).ino).not.toBe((await fs.promises.stat(copied)).ino);
    expect(checksums).toEqual([{ relPath: 'results/branch-1.txt', size: 16, sha256: crypto.createHash('sha256').update('Complete result\n').digest('hex') }]);
    await fs.promises.rm(path.join(root, 'conversations/source'), { recursive: true });
    expect(await fs.promises.readFile(copied, 'utf8')).toBe('Complete result\n');
  });

  it('deleting the child leaves the original attachment usable', async () => {
    const original = await put('conversations/source/results/full.txt', 'Complete result');
    await publish(await prepare());
    await fs.promises.rm(path.join(root, 'conversations/child'), { recursive: true });
    expect(await fs.promises.readFile(original, 'utf8')).toBe('Complete result');
  });

  it.each([0, 2 * 1024 * 1024 + 17])('copies %i bytes through retained native handles', async size => {
    const bytes = Buffer.alloc(size, 173);
    const original = await put('conversations/source/results/full.txt', bytes);
    const prepared = await prepare();
    const checksums = await publish(prepared);
    const copied = path.join(root, 'conversations/child/results/branch-1.txt');
    expect((await fs.promises.readFile(copied)).equals(bytes)).toBe(true);
    expect(checksums[0]).toMatchObject({ size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    await fs.promises.writeFile(original, 'Changed source');
    expect((await fs.promises.readFile(copied)).equals(bytes)).toBe(true);
  });

  it('native copies reject existing destinations, wrong sizes and write-only sources', async () => {
    const original = await put('conversations/source/results/full.txt', 'Source');
    const existing = await put('conversation-branches/child/existing.txt', 'Keep');
    const source = { path: original, purpose: 'read', followFinalSymlink: false };
    const destination = { path: existing, purpose: 'write', followFinalSymlink: false };
    const missing = { ...destination, path: path.join(root, 'conversation-branches/child/new.txt') };
    const writeOnly = { ...source, purpose: 'write' };
    const session = native.createNativeFileSession([source, destination, missing, writeOnly]);
    try {
      const input = await session.request('observe', source);
      const output = await session.request('observe', destination);
      const empty = await session.request('observe', missing);
      const unreadable = await session.request('observe', writeOnly);
      await expect(session.request('copy-file', { reference: output.reference, sourceReference: input.reference, size: 6 })).rejects.toThrow();
      await expect(session.request('copy-file', { reference: empty.reference, sourceReference: input.reference, size: 5 })).rejects.toThrow();
      await expect(session.request('copy-file', { reference: empty.reference, sourceReference: input.reference, size: host.MAX_FILE_BYTES + 1 })).rejects.toThrow();
      await expect(session.request('copy-file', { reference: empty.reference, sourceReference: unreadable.reference, size: 6 })).rejects.toThrow();
      expect(await fs.promises.readFile(existing, 'utf8')).toBe('Keep');
      expect(fs.existsSync(missing.path)).toBe(false);
    } finally { await session.release(); }
  });

  it('native copies reject source replacement and cancelled sessions', async () => {
    const original = await put('conversations/source/results/full.txt', 'Source');
    const source = { path: original, purpose: 'read', followFinalSymlink: false };
    const destination = { path: path.join(root, 'conversation-branches/child/new.txt'), purpose: 'write', followFinalSymlink: false };
    const session = native.createNativeFileSession([source, destination]);
    try {
      const input = await session.request('observe', source);
      const output = await session.request('observe', destination);
      if (process.platform === 'win32') {
        await expect(fs.promises.rename(original, `${original}.saved`)).rejects.toThrow();
        expect(await session.request('copy-file', { reference: output.reference, sourceReference: input.reference, size: 6 })).toEqual({ written: 6 });
        expect(await fs.promises.readFile(destination.path, 'utf8')).toBe('Source');
      } else {
        await fs.promises.rename(original, `${original}.saved`);
        await fs.promises.writeFile(original, 'Other!');
        await expect(session.request('copy-file', { reference: output.reference, sourceReference: input.reference, size: 6 })).rejects.toThrow();
        expect(fs.existsSync(destination.path)).toBe(false);
      }
      await session.release();
      await expect(session.request('copy-file', { reference: output.reference, sourceReference: input.reference, size: 6 })).rejects.toThrow();
    } finally { await session.release(); }
  });

  it('copies images and inline PDFs without reading outside conversation storage', async () => {
    await put('conversations/source/outputs/images/photo.png', Buffer.from(PNG, 'base64'));
    const messages: Message[] = [{ id: 'child-user', role: 'user', timestamp: 1, content: [
      { type: 'image', filePath: path.join(root, 'conversations/source/outputs/images/photo.png'), source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'document', name: 'report.pdf', originConversationId: 'source', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
    ] }, assistant({ toolCalls: [{ ...call(), fullResultRef: undefined, resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] })];
    const prepared = await prepare(messages);
    const checksums = await publish(prepared);
    expect(checksums).toHaveLength(2);
    for (const file of checksums) expect(await fs.promises.readFile(path.join(root, 'conversations/child', file.relPath))).toEqual(Buffer.from(PNG, 'base64'));
    expect(prepared.plan.messages[0].content[1]).toMatchObject({ originConversationId: 'child', source: { data: PDF } });
  });

  it('preserves missing files as missing even if a source file appears before copying', async () => {
    const prepared = await prepare();
    expect(prepared.plan.messages[0].toolCalls[0].fullResultRef.missing).toBe(true);
    await put('conversations/source/results/full.txt', 'Later file');
    expect(await host.copyBranchFiles(prepared)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'conversation-branches/child/results/branch-1.txt'))).toBe(false);
  });

  it('fails when an originally available file disappears before copying', async () => {
    const filename = await put('conversations/source/results/full.txt', 'Complete result');
    const prepared = await prepare();
    await fs.promises.unlink(filename);
    await expect(host.copyBranchFiles(prepared)).rejects.toMatchObject({ code: 'source-changed' });
    expect(fs.existsSync(path.join(root, 'conversations/child'))).toBe(false);
  });

  it('fails when bytes change between preparation and copying, even with identical size', async () => {
    const filename = await put('conversations/source/results/full.txt', 'Version A');
    const prepared = await prepare();
    await fs.promises.writeFile(filename, 'Version B');
    await expect(host.copyBranchFiles(prepared)).rejects.toMatchObject({ code: 'source-changed' });
  });

  it('detects replacement with a different file containing identical bytes', async () => {
    const filename = await put('conversations/source/results/full.txt', 'Same content');
    const prepared = await prepare();
    const replacement = await put('replacement.txt', 'Same content');
    await fs.promises.rename(replacement, filename);
    await expect(host.copyBranchFiles(prepared)).rejects.toMatchObject({ code: 'source-changed' });
  });

  it('detects a source edit during a streaming read', async () => {
    const filename = await put('conversations/source/results/full.txt', Buffer.alloc(600_000, 65));
    const prepared = await prepare();
    let changed = false;
    await expect(host.readPinnedFile(prepared.root, prepared.rootIdentity, 'conversations/source/results/full.txt', prepared.records[0].frozen, host.MAX_FILE_BYTES, async () => {
      if (changed) return;
      changed = true;
      await fs.promises.writeFile(filename, Buffer.alloc(600_000, 66));
    })).rejects.toMatchObject({ code: 'source-changed' });
  });

  it('reports permission errors during preparation and never records them as missing', async () => {
    const filename = await put('conversations/source/results/full.txt', 'Complete result');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (args[0] === filename) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
      return open(...args);
    });
    await expect(prepare()).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('terminates on destination write failure', async () => {
    await put('conversations/source/results/full.txt', 'Complete result');
    const prepared = await prepare();
    const destination = path.join(root, 'conversation-branches');
    await fs.promises.writeFile(destination, 'Occupied destination');
    await expect(host.copyBranchFiles(prepared)).rejects.toThrow();
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('Occupied destination');
    expect(fs.existsSync(path.join(root, 'conversations/child'))).toBe(false);
  });

  it.each(['file', 'parent'] as const)('refuses a symbolic link in the %s position', async position => {
    await put('outside/full.txt', 'Private');
    if (position === 'parent') {
      await fs.promises.symlink(path.join(root, 'outside'), path.join(root, 'conversations/source/results'), 'dir');
    } else {
      await fs.promises.mkdir(path.join(root, 'conversations/source/results'));
      await fs.promises.symlink(path.join(root, 'outside/full.txt'), path.join(root, 'conversations/source/results/full.txt'));
    }
    await expect(prepare()).rejects.toMatchObject({ code: 'unsafe-file' });
  });

  it('refuses a hard-linked source', async () => {
    const outside = await put('outside.txt', 'Private');
    await fs.promises.mkdir(path.join(root, 'conversations/source/results'));
    await fs.promises.link(outside, path.join(root, 'conversations/source/results/full.txt'));
    await expect(prepare()).rejects.toMatchObject({ code: 'unsafe-file' });
  });

  it('refuses a linked staging directory and does not write into it', async () => {
    await put('conversations/source/results/full.txt', 'Complete result');
    const prepared = await prepare();
    await fs.promises.mkdir(path.join(root, 'outside'));
    await fs.promises.symlink(path.join(root, 'outside'), path.join(root, 'conversation-branches'), 'dir');
    await expect(host.copyBranchFiles(prepared)).rejects.toThrow();
    expect(await fs.promises.readdir(path.join(root, 'outside'))).toEqual([]);
  });

  it('refuses to overwrite a previously prepared child file', async () => {
    await put('conversations/source/results/full.txt', 'Complete result');
    const prepared = await prepare();
    await put('conversation-branches/child/results/branch-1.txt', 'Existing');
    await expect(host.copyBranchFiles(prepared)).rejects.toMatchObject({ code: 'destination-exists' });
    expect(await fs.promises.readFile(path.join(root, 'conversation-branches/child/results/branch-1.txt'), 'utf8')).toBe('Existing');
  });

  it('reads legacy results only from the matching source session, after the current location', async () => {
    await put('sessions/source/results/call.txt', 'Legacy');
    const messages = [assistant({ toolCalls: [{ ...call(), fullResultRef: undefined, result: '[session-memory:call]Preview' }] })];
    const first = await prepare(messages);
    expect(first.records[0].sourceRelative).toBe('sessions/source/results/call.txt');
    await put('conversations/source/results/call.txt', 'Current');
    const second = await prepare(messages);
    expect(second.records[0].sourceRelative).toBe('conversations/source/results/call.txt');
    await publish(second);
    expect(await fs.promises.readFile(path.join(root, 'conversations/child/results/branch-1.txt'), 'utf8')).toBe('Current');
  });

  it('retains exact historical captures and excludes future captures in the manifest log', async () => {
    await put('conversations/source/outputs/files/capture/report.txt', 'Original');
    await put('conversations/source/outputs/files/future/report.txt', 'Future');
    await put('conversations/source/outputs/manifest-log.jsonl', [snapshot(), snapshot({ refId: 'future-call', captureId: 'future', snapshotRelPath: 'files/future/report.txt' })].map(entry => JSON.stringify({ op: 'set', entry })).join('\n'));
    const prepared = await prepare([assistant({ toolCalls: [{ ...call(), fullResultRef: undefined }] })]);
    const checksums = await publish(prepared);
    expect(checksums).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(root, 'conversations/child', checksums[0].relPath), 'utf8')).toBe('Original');
  });

  it('rejects a manifest revision that replaces a shared snapshot before its initial file read', async () => {
    const filename = await put('conversations/source/outputs/files/capture/report.txt', 'Version A');
    const manifest = await put('conversations/source/outputs/manifest-log.jsonl', JSON.stringify({ op: 'set', entry: snapshot() }));
    const lstat = fs.promises.lstat.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (args[0] === filename && !replaced) {
        replaced = true;
        await fs.promises.writeFile(filename, 'Version B');
        await fs.promises.appendFile(manifest, `\n${JSON.stringify({ op: 'set', entry: snapshot({ refId: 'future-call', captureId: 'future' }) })}`);
      }
      return lstat(...args);
    });
    await expect(prepare([assistant({ toolCalls: [{ ...call(), fullResultRef: undefined }] })])).rejects.toMatchObject({ code: 'source-changed' });
  });

  it('native creation rejects a replaced parent before creating any outside file', async () => {
    const directory = path.join(root, 'conversation-branches/child/results');
    const outside = path.join(root, 'outside');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.mkdir(outside);
    const target = { path: path.join(directory, 'result.txt'), purpose: 'write', followFinalSymlink: false };
    const session = native.createNativeFileSession([target]);
    try {
      const observed = await session.request('observe', target);
      await fs.promises.rename(directory, `${directory}-original`);
      await fs.promises.symlink(outside, directory, 'dir');
      await expect(session.request('write-chunk', { reference: observed.reference, offset: 0, bytes: [65] })).rejects.toThrow();
      expect(await fs.promises.readdir(outside)).toEqual([]);
      expect(await fs.promises.readdir(`${directory}-original`)).toEqual([]);
    } finally {
      await session.release();
    }
  });

  it('native streaming requires continuous offsets and the exact final size', async () => {
    const filename = path.join(root, 'conversation-branches/child/results/result.txt');
    const target = { path: filename, purpose: 'write', followFinalSymlink: false };
    const session = native.createNativeFileSession([target]);
    try {
      const observed = await session.request('observe', target);
      const reference = observed.reference;
      await expect(session.request('write-chunk', { reference, offset: host.MAX_FILE_BYTES + 1, bytes: [] })).rejects.toThrow();
      await expect(session.request('write-chunk', { reference, offset: 1, bytes: [65] })).rejects.toThrow();
      expect(fs.existsSync(filename)).toBe(false);
      expect(await session.request('write-chunk', { reference, offset: 0, bytes: [65, 66] })).toEqual({ written: 2 });
      await expect(session.request('write-chunk', { reference, offset: 1, bytes: [88] })).rejects.toThrow();
      await expect(session.request('finish-write', { reference, size: 3 })).rejects.toThrow();
      expect(await session.request('write-chunk', { reference, offset: 2, bytes: [67] })).toEqual({ written: 3 });
      await session.request('finish-write', { reference, size: 3 });
      expect(await fs.promises.readFile(filename, 'utf8')).toBe('ABC');
      await expect(session.request('write-chunk', { reference, offset: 0, bytes: [88] })).rejects.toThrow();
    } finally {
      await session.release();
    }
  });

  it('treats an overwritten legacy snapshot as missing and never copies its future contents', async () => {
    await put('conversations/source/outputs/files/capture/report.txt', 'Future');
    await put('conversations/source/outputs/manifest-log.jsonl', [snapshot(), snapshot({ refId: 'future-call', captureId: 'future' })].map(entry => JSON.stringify({ op: 'set', entry })).join('\n'));
    const prepared = await prepare([assistant({ toolCalls: [{ ...call(), fullResultRef: undefined }] })]);
    expect(prepared.records).toEqual([]);
    expect(Object.values(prepared.plan.manifest.entries)).toEqual([expect.objectContaining({ missing: true })]);
  });

  it('keeps a removed snapshot missing even if its old pathname still exists', async () => {
    await put('conversations/source/outputs/files/capture/report.txt', 'Original');
    await put('conversations/source/outputs/manifest-log.jsonl', `${JSON.stringify({ op: 'set', entry: snapshot() })}\n${JSON.stringify({ op: 'remove', originalPath: '/work/report.txt', snapshottedAt: 2, captureId: 'capture' })}`);
    const prepared = await prepare([assistant({ toolCalls: [{ ...call(), fullResultRef: undefined }] })]);
    expect(prepared.records).toEqual([]);
  });

  it.each(['{broken', JSON.stringify({ version: 2, entries: {} }), JSON.stringify({ version: 1, entries: { bad: snapshot() } })])('fails on unreadable manifest %s', async text => {
    await put('conversations/source/outputs/manifest.json', text);
    await expect(prepare()).rejects.toThrow();
  });

  it('fails on a corrupt log record', async () => {
    await put('conversations/source/outputs/manifest-log.jsonl', '{unfinished');
    await expect(prepare()).rejects.toThrow();
  });

  it.each(['image/png', 'application/pdf'])('fails on invalid inline %s bytes', async mediaType => {
    const content = mediaType === 'image/png'
      ? { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aW52YWxpZA==' } }
      : { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'aW52YWxpZA==' } };
    await expect(prepare([{ id: 'child-user', role: 'user', timestamp: 1, content: [content] }])).rejects.toMatchObject({ code: 'invalid-attachment' });
  });

  it('rejects an oversized source before reading its payload', async () => {
    const filename = await put('conversations/source/results/full.txt', '');
    await fs.promises.truncate(filename, host.MAX_FILE_BYTES + 1);
    await expect(prepare()).rejects.toMatchObject({ code: 'file-too-large' });
  });

  it.each(['retained.bin', 'inherited/1/manifest.json', 'files/capture/manifest-log.jsonl'])('counts the attachment %s toward the total storage limit without removing it', async relative => {
    await put('conversations/source/results/full.txt', 'Complete result');
    const existing = await put(`conversations/other/outputs/${relative}`, '');
    await fs.promises.truncate(existing, host.MAX_TOTAL_BYTES);
    await expect(prepare()).rejects.toMatchObject({ code: 'storage-limit' });
    expect((await fs.promises.stat(existing)).size).toBe(host.MAX_TOTAL_BYTES);
  });

  it.each(['../escape', 'SOURCE', 'con', 'index.json'])('refuses invalid child id %s', async childId => {
    await expect(prepare([], childId)).rejects.toThrow();
  });
});
