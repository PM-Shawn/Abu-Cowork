import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { SnapshotEntry } from './outputSnapshots';
import { buildConversationBranchFilePlan, assertBranchRelativePath, markBranchFilesMissing } from './conversationBranchFiles';
import { readToolResultFileReference, rewriteToolResultFileNote, SPILL_NOTE_ENDING } from './toolResultFileReference';
import { stripForDisk } from './ledgerLineSerializer';

const sourceDirectory = '/app/conversations/source';
const childDirectory = '/app/conversations/child';
const note = (path: string) => `Preview\n\n[The full output (140000 characters) is saved at ${path}. ${SPILL_NOTE_ENDING}`;
const user: Message = { id: 'child-user', role: 'user', content: 'Question', timestamp: 1 };
const entry = (overrides: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  originalPath: '/work/report.txt', basename: 'report.txt', snapshotRelPath: 'files/capture/report.txt',
  size: 6, originalMtime: 1, snapshottedAt: 2, source: 'tool-output', refId: 'call-old', refKind: 'write_file',
  captureId: 'capture-old', ...overrides,
});
function plan(messages: Message[], entries: SnapshotEntry[] = []) {
  return buildConversationBranchFilePlan({
    sourceConversationId: 'source', childConversationId: 'child', sourceDirectory, childDirectory,
    messages, entries, messageIdMap: new Map([['source-user', 'child-user']]),
  });
}

describe('conversation branch managed references', () => {
  it('only recognizes application-generated tool result notes and keeps ordinary paths intact', () => {
    const text = note(`${sourceDirectory}/results/result-1.txt`);
    expect(readToolResultFileReference(text, 'source')).toEqual({ relPath: 'results/result-1.txt' });
    expect(readToolResultFileReference(text, 'other')).toBeUndefined();
    expect(readToolResultFileReference(`${text}\nMore text`, 'source')).toBeUndefined();
    expect(readToolResultFileReference(note(`${sourceDirectory}/results/../secret.txt`), 'source')).toBeUndefined();
    expect(readToolResultFileReference(note(`${sourceDirectory}/results/nested/file.txt`), 'source')).toBeUndefined();
    const result = rewriteToolResultFileNote(`${sourceDirectory}/results/ordinary.txt\n${text}`, `${childDirectory}/results/new.txt`, false);
    expect(result).toContain(`${sourceDirectory}/results/ordinary.txt`);
    expect(readToolResultFileReference(result, 'child')).toEqual({ relPath: 'results/new.txt' });
    const missing = rewriteToolResultFileNote(result, '', true);
    expect(missing).toContain('unavailable');
    expect(missing).not.toContain('Read the part');
    expect(rewriteToolResultFileNote(missing, '', true)).toBe(missing);
  });

  it('rewrites legacy session markers and recognizes a Windows generated note', () => {
    expect(readToolResultFileReference('[session-memory:call_1]Preview', 'source')).toEqual({ relPath: 'results/call_1.txt', legacy: true });
    expect(readToolResultFileReference('[session-memory:../file]Preview', 'source')).toBeUndefined();
    expect(readToolResultFileReference(note('C:\\app\\conversations\\source\\results\\call.txt'), 'source')).toEqual({ relPath: 'results/call.txt' });
    const result = rewriteToolResultFileNote('[session-memory:call_1]Preview', `${childDirectory}/results/new.txt`, false);
    expect(result).toMatch(/^Preview/);
    expect(readToolResultFileReference(result, 'child')).toEqual({ relPath: 'results/new.txt' });
  });

  it.each(['../file', 'a/../file', '/absolute', 'a\\b', 'C:/file', 'a//b', 'a/./b', 'a/nul.txt', 'a/file.', 'a/file ', 'a/\u0000b'])('rejects unsafe relative path %j', value => {
    expect(() => assertBranchRelativePath(value)).toThrow();
  });

  it('deduplicates exact result references across display, context and execution details', () => {
    const result = note(`${sourceDirectory}/results/one.txt`);
    const message: Message = {
      id: 'child-assistant', role: 'assistant', timestamp: 2, content: 'Done',
      toolCalls: [{ id: 'call-old', name: 'run_command', input: {}, result }],
      toolCallsForContext: [{ id: 'call-old', name: 'run_command', input: {}, result }],
      executionSteps: [{ id: 'step', type: 'tool', label: 'Command', status: 'completed', toolName: 'run_command', detailBlocks: [{ id: 'detail', title: 'Result', type: 'result', content: result }] }],
    };
    const original = structuredClone(message);
    const built = plan([user, message]);
    expect(built.files).toHaveLength(1);
    expect(built.messages[1].toolCalls?.[0].fullResultRef).toEqual({ relPath: 'results/branch-1.txt' });
    markBranchFilesMissing(built, childDirectory, new Set(['results/branch-1.txt']));
    expect(built.messages[1].toolCalls?.[0].result).toContain('unavailable');
    expect(built.messages[1].toolCallsForContext?.[0].result).toContain('unavailable');
    expect(built.messages[1].executionSteps?.[0].detailBlocks?.[0].content).toContain('unavailable');
    expect(message).toEqual(original);
  });

  it('copies only referenced captures and preserves separate versions of the same original', () => {
    const message: Message = { ...user, toolCalls: [
      { id: 'call-old', name: 'write_file', input: {}, result: 'old' },
      { id: 'call-new', name: 'write_file', input: {}, result: 'new' },
    ] };
    const built = plan([message], [entry(), entry({ refId: 'call-new', captureId: 'capture-new', snapshotRelPath: 'files/new/report.txt' }), entry({ refId: 'call-future', snapshotRelPath: 'files/future/report.txt' })]);
    expect(built.files.map(file => file.sourceRelPath)).toEqual(['outputs/files/capture/report.txt', 'outputs/files/new/report.txt']);
    expect(Object.values(built.manifest.entries)).toHaveLength(2);
    expect(Object.values(built.manifest.entries).every(value => value.inheritedFromBranch)).toBe(true);
    expect(built.manifest.entries['/work/report.txt'].refId).toBe('call-new');
  });

  it('marks an overwritten shared path missing without copying later bytes into an earlier capture', () => {
    const message: Message = { ...user, toolCalls: [{ id: 'call-old', name: 'write_file', input: {}, result: 'old' }] };
    const built = plan([message], [entry(), entry({ refId: 'call-future', captureId: 'future' })]);
    expect(built.files).toHaveLength(1);
    expect(built.files[0].missing).toBe(true);
  });

  it('uses the same missing copy for a user image whose shared upload path was overwritten', () => {
    const message: Message = { ...user, content: [
      { type: 'image', filePath: '/external/photo.png', source: { type: 'base64', media_type: 'image/png', data: '' } },
    ] };
    const built = plan([message], [
      entry({ source: 'user-upload', refId: 'source-user', originalPath: '/external/photo.png' }),
      entry({ source: 'user-upload', refId: 'future-user', originalPath: '/external/photo.png', captureId: 'future' }),
    ]);
    expect(built.files).toHaveLength(1);
    expect(built.files[0].missing).toBe(true);
    expect(built.messages[0].content).toEqual([
      { type: 'image', filePath: `${childDirectory}/${built.files[0].targetRelPath}`, source: { type: 'base64', media_type: 'image/png', data: '' } },
    ]);
  });

  it('keeps a previously copied image available when branching again', () => {
    const message: Message = { ...user, content: [
      { type: 'image', filePath: `${sourceDirectory}/outputs/inherited/1/photo.png`, source: { type: 'base64', media_type: 'image/png', data: '' } },
    ] };
    const built = plan([message], [entry({ originalPath: `${sourceDirectory}/outputs/inherited/1/photo.png`, refId: '', refKind: 'branch-attachment', inheritedFromBranch: true, snapshotRelPath: 'inherited/1/photo.png' })]);
    expect(built.files).toHaveLength(1);
    expect(built.files[0].missing).toBeUndefined();
  });

  it('keeps an exact tool image reference available across consecutive branches', () => {
    const message: Message = { ...user, toolCalls: [{ id: 'call', name: 'screenshot', input: {}, result: 'Image', resultContent: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, outputRef: { relPath: 'images/result.png' } },
    ] }] };
    const first = plan([message]);
    const second = buildConversationBranchFilePlan({
      sourceConversationId: 'child', childConversationId: 'grandchild', sourceDirectory: childDirectory,
      childDirectory: '/app/conversations/grandchild', messages: first.messages, entries: Object.values(first.manifest.entries), messageIdMap: new Map(),
    });
    expect(second.files).toHaveLength(1);
    expect(second.files[0].missing).toBeUndefined();
  });

  it('shares inline result copies across both tool lists without confusing them with managed files', () => {
    const inline = { id: 'call', name: 'screenshot', input: {}, result: 'Image', resultContent: [
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'inline bytes' } },
    ] };
    const built = plan([{ ...user, toolCalls: [inline], toolCallsForContext: [inline] }], [
      entry({ refId: 'call', snapshotRelPath: 'images/inline-call-0.image' }),
    ]);
    expect(built.files).toHaveLength(2);
    expect(built.files[0].sourceArea).toBe('conversation');
    expect(built.files[0].inline).toBeUndefined();
    expect(built.files[1].sourceArea).toBe('inline');
    expect(built.messages[0].toolCalls?.[0].resultContent).toEqual(built.messages[0].toolCallsForContext?.[0].resultContent);
  });

  it('maps user uploads and PDF provenance, retaining PDF bytes', () => {
    const message: Message = { ...user, content: [
      { type: 'image', filePath: '/external/photo.png', source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'document', name: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'PDF bytes' }, originConversationId: 'source' },
    ] };
    const built = plan([message], [entry({ originalPath: '/external/photo.png', refId: 'source-user', source: 'user-upload', snapshotRelPath: 'images/photo.png' })]);
    expect(built.files).toHaveLength(1);
    expect(built.messages[0].content).toEqual([
      { type: 'image', filePath: `${childDirectory}/outputs/inherited/1/photo.png`, source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'document', name: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'PDF bytes' }, originConversationId: 'child' },
    ]);
    expect(Object.values(built.manifest.entries)[0].refId).toBe('child-user');
  });

  it('keeps unavailable structured results unavailable on another branch', () => {
    const built = plan([{ ...user, toolCalls: [{ id: 'call', name: 'run_command', input: {}, result: 'Preview', fullResultRef: { relPath: 'results/old.txt', missing: true } }] }]);
    expect(built.files[0].missing).toBe(true);
    expect(built.messages[0].toolCalls?.[0].fullResultRef?.missing).toBe(true);
    expect(built.messages[0].toolCalls?.[0].result).toContain('unavailable');
    expect(() => plan([{ ...user, toolCalls: [{ id: 'call', name: 'run_command', input: {}, result: 'Preview', fullResultRef: { relPath: 'outputs/secret' } }] }])).toThrow();
  });

  it('records structured references in both persisted tool lists without changing their input', () => {
    const call = { id: 'call', name: 'run_command', input: {}, result: note(`${sourceDirectory}/results/full.txt`) };
    const message: Message = { ...user, toolCalls: [call], toolCallsForContext: [call] };
    const saved = stripForDisk(message, 'source', { findToolResultImageSnapshot: () => null });
    expect(saved.toolCalls?.[0].fullResultRef).toEqual({ relPath: 'results/full.txt' });
    expect(saved.toolCallsForContext?.[0].fullResultRef).toEqual({ relPath: 'results/full.txt' });
    expect(call).not.toHaveProperty('fullResultRef');
    const ordinary = stripForDisk({ ...user, toolCalls: [{ ...call, result: 'ordinary' }] }, 'source', { findToolResultImageSnapshot: () => null });
    expect(ordinary.toolCalls?.[0]).not.toHaveProperty('fullResultRef');
  });
});
