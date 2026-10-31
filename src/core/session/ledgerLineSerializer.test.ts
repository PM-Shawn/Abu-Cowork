import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { serializeLedgerPut, stripForDisk } from './ledgerLineSerializer';

const options = { findToolResultImageSnapshot: () => null };

const message: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  toolCalls: [{
    id: 'call-edit',
    name: 'edit_file',
    input: { path: '/w/plan.md', old_content: 'a', new_content: 'b' },
    result: 'Successfully edited /w/plan.md: replaced 1 line(s) with 1 line(s)',
    fileChange: {
      path: '/w/plan.md',
      kind: 'modify',
      added: 1,
      deleted: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    },
  }],
};

describe('ledger line serialization of a tool call file change', () => {
  it('keeps the file change in the disk projection', () => {
    const stripped = stripForDisk(message, 'conv-1', options);
    expect(stripped.toolCalls?.[0].fileChange).toEqual(message.toolCalls?.[0].fileChange);
  });

  it('writes the file change into the ledger line', () => {
    const line = JSON.parse(serializeLedgerPut('conv-1', message, undefined, options)) as Message;
    expect(line.toolCalls?.[0].fileChange).toEqual(message.toolCalls?.[0].fileChange);
  });
});

describe('ledger image references across repeated writes', () => {
  it('keeps the display and context images when loaded history is written again', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'YQ==' } };
    const call = { id: 'image-call', name: 'read_file', input: { path: '/work/image.png' }, result: 'Image', resultContent: [image] };
    const original: Message = { id: 'reply', role: 'assistant', content: '', timestamp: 1, toolCalls: [call], toolCallsForContext: [call] };
    const snapshot = { snapshotRelPath: 'files/image/result.png', basename: 'result.png', size: 1 };
    const first = JSON.parse(serializeLedgerPut('source', original, undefined, { findToolResultImageSnapshot: () => snapshot })) as Message;
    const second = JSON.parse(serializeLedgerPut('source', first, undefined, options)) as Message;
    const third = JSON.parse(serializeLedgerPut('source', second, undefined, options)) as Message;
    for (const stored of [first, second, third]) {
      for (const projection of [stored.toolCalls, stored.toolCallsForContext]) {
        expect(projection?.[0].resultContent).toEqual([{
          ...image, source: { ...image.source, data: '' },
          outputRef: { relPath: snapshot.snapshotRelPath, basename: snapshot.basename, sizeBytes: 1 },
        }]);
        expect(projection?.[0].result).toBe('Image');
      }
    }
    expect(original.toolCalls?.[0].resultContent).toEqual([image]);
  });
});
