import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { joinPath } from '@/utils/pathUtils';
import { isOpaqueMediaId } from '@/core/subagent/delegatedUserTurn';
import {
  assertConversationId,
  ConversationIdError,
  conversationIdRejection,
  createConversationPaths,
  isConversationId,
  isDirectChildPath,
  joinConversationPath,
} from './conversationPaths';

const fixtures = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/conversationId.fixtures.json'),
  'utf8',
)) as {
  accepted: string[];
  rejectedByBoth: { value: string; reason: string }[];
  rejectedByConversationGrammarOnly: { value: string; reason: string }[];
  notStrings: unknown[];
};

describe('conversation id grammar', () => {
  it.each(fixtures.accepted)('accepts %j', (value) => {
    expect(conversationIdRejection(value)).toBeNull();
    expect(isConversationId(value)).toBe(true);
    expect(isOpaqueMediaId(value)).toBe(true);
  });
  it.each(fixtures.rejectedByBoth)('rejects $value ($reason), as the media grammar does', ({ value, reason }) => {
    expect(conversationIdRejection(value)).toBe(reason);
    expect(isOpaqueMediaId(value)).toBe(false);
  });
  it.each(fixtures.rejectedByConversationGrammarOnly)('rejects $value ($reason)', ({ value, reason }) => {
    expect(conversationIdRejection(value)).toBe(reason);
  });
  it.each(fixtures.notStrings)('rejects the non-string %j', (value) => {
    expect(conversationIdRejection(value)).toBe('not_a_string');
  });
  it('accepts what the store generator produces', () => {
    for (const now of [0, 1, 1_700_000_000_000, 8_640_000_000_000_000]) {
      for (const random of [0, 0.5, 0.999999999]) {
        expect(isConversationId(now.toString(36) + random.toString(36).substring(2, 8))).toBe(true);
      }
    }
  });
  it('throws a typed error that carries the reason and never the value', () => {
    let thrown: unknown;
    try { assertConversationId('../../etc/passwd'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ConversationIdError);
    expect((thrown as ConversationIdError).code).toBe('conversation_id_invalid');
    expect((thrown as ConversationIdError).reason).toBe('charset');
    expect((thrown as ConversationIdError).message).not.toContain('passwd');
  });
});

describe('conversation paths', () => {
  const paths = createConversationPaths('/Users/testuser/.abu');
  it('builds the paths conversationStorage has always built', () => {
    expect(paths.root).toBe('/Users/testuser/.abu/conversations');
    expect(paths.indexFilePath()).toBe('/Users/testuser/.abu/conversations/index.json');
    expect(paths.sweepMarkerPath()).toBe('/Users/testuser/.abu/conversations/.snapshot-sweep-version');
    expect(paths.backupDir).toBe('/Users/testuser/.abu/backups');
    expect(paths.conversationDir('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1');
    expect(paths.messagesPath('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1/messages.jsonl');
    expect(paths.streamSnapshotPath('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1/stream-snapshot.json');
    expect(paths.legacySessionDir('conv-1')).toBe('/Users/testuser/.abu/sessions/conv-1');
  });
  it('normalises a Windows app data directory the way joinPath does', () => {
    const win = createConversationPaths('C:\\Users\\me\\AppData\\Roaming\\abu');
    expect(win.messagesPath('conv-1')).toBe(joinPath('C:\\Users\\me\\AppData\\Roaming\\abu', 'conversations', 'conv-1', 'messages.jsonl'));
  });
  it.each([[['a', 'b']], [['a/', '/b']], [['a\\b', 'c']], [['/x//y', 'z']]])('joinConversationPath(%j) equals joinPath', (segments) => {
    expect(joinConversationPath(...segments)).toBe(joinPath(...segments));
  });
  it.each(['../x', 'a/b', '', 'CON', 'abc.', 'index.json'])('every builder refuses %j before building', (bad) => {
    for (const build of [paths.conversationDir, paths.messagesPath, paths.streamSnapshotPath, paths.legacySessionDir]) {
      expect(() => build(bad)).toThrow(ConversationIdError);
    }
  });
  it('never lets a conversation directory name a file the conversations root already holds', () => {
    const rootFiles = new Set([paths.indexFilePath(), paths.sweepMarkerPath()]);
    for (const value of fixtures.accepted) {
      expect(rootFiles.has(paths.conversationDir(value))).toBe(false);
    }
  });
  it('maps a ledger path back to its conversation and nothing else', () => {
    expect(paths.conversationIdOfMessagesPath(paths.messagesPath('conv-1'))).toBe('conv-1');
    expect(paths.conversationIdOfMessagesPath(paths.indexFilePath())).toBeUndefined();
    expect(paths.conversationIdOfMessagesPath(paths.streamSnapshotPath('conv-1'))).toBeUndefined();
  });
});

describe('conversation paths outside the ledger', () => {
  const paths = createConversationPaths('/Users/testuser/.abu');
  it('builds the outputs, results and checkpoint paths the rest of the app writes', () => {
    expect(paths.outputsDir('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1/outputs');
    expect(paths.resultsDir('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1/results');
    expect(paths.checkpointPath('conv-1')).toBe('/Users/testuser/.abu/conversations/conv-1/checkpoint.json');
  });
  it.each(['../x', 'a/b', '', 'CON', 'abc.', 'index.json'])('refuses %j before building', (bad) => {
    for (const build of [paths.outputsDir, paths.resultsDir, paths.checkpointPath]) {
      expect(() => build(bad)).toThrow(ConversationIdError);
    }
  });
});

describe('isDirectChildPath', () => {
  it.each([
    ['/r/conversations', '/r/conversations/abc', true],
    ['/r/conversations/', '/r/conversations/abc', true],
    ['C:\\r\\conversations', 'C:\\r\\conversations\\abc', true],
    ['/r/conversations', '/r/conversations', false],
    ['/r/conversations', '/r/conversations/abc/def', false],
    ['/r/conversations', '/r/conversations-evil/abc', false],
    ['/r/conversations', '/elsewhere/abc', false],
  ])('%s ⊃ %s → %s', (root, target, expected) => {
    expect(isDirectChildPath(root, target)).toBe(expected);
  });

  it.each([
    ['/r/conversations', '/r/conversations/..'],
    ['/r/conversations', '/r/conversations/.'],
    ['/r/conversations', '/r/conversations/../'],
    ['C:\\r\\conversations', 'C:\\r\\conversations\\..'],
  ])('%s ⊅ %s, whose final segment names the root or its parent', (root, target) => {
    expect(isDirectChildPath(root, target)).toBe(false);
  });

  it('refuses every child of the filesystem root, which is never the conversations root', () => {
    expect(isDirectChildPath('/', '/abc')).toBe(false);
    expect(isDirectChildPath('/', '/')).toBe(false);
  });
});
