import { describe, it, expect } from 'vitest';
import type { Message } from '../../types';
import {
  appendInstructionToHistory,
  clearDispatchInputs,
  drainDispatchInputs,
  enqueueDispatchInput,
  hasDispatchInput,
  noteDeliveredInstruction,
  takeDeliveredInstructions,
} from './dispatchInput';

describe('dispatch input queue (direct instruction to a running member)', () => {
  it('queues per hand-off key, drains oldest first, and drops blanks', () => {
    enqueueDispatchInput('tc-1:0', ' 先看 Q3 ');
    enqueueDispatchInput('tc-1:0', '再看 Q4');
    enqueueDispatchInput('tc-1:0', '   ');
    enqueueDispatchInput('tc-1:1', '别的队员');
    expect(hasDispatchInput('tc-1:0')).toBe(true);
    expect(drainDispatchInputs('tc-1:0')).toEqual(['先看 Q3', '再看 Q4']);
    expect(hasDispatchInput('tc-1:0')).toBe(false);
    expect(drainDispatchInputs('tc-1:0')).toEqual([]);
    clearDispatchInputs('tc-1:1');
    expect(drainDispatchInputs('tc-1:1')).toEqual([]);
  });

  it('keeps a shell-side log of delivered instructions per hand-off, taken once', () => {
    noteDeliveredInstruction('tc-5:0', ' 只看 Q3 ');
    noteDeliveredInstruction('tc-5:0', '');
    noteDeliveredInstruction('tc-5:1', '别的');
    expect(takeDeliveredInstructions('tc-5:0')).toEqual(['只看 Q3']);
    expect(takeDeliveredInstructions('tc-5:0')).toEqual([]);
    expect(takeDeliveredInstructions('tc-5:1')).toEqual(['别的']);
  });

  it('merges into a trailing user message (string or blocks) and otherwise appends a user turn', () => {
    const history: Message[] = [{ id: 'u0', role: 'user', content: '任务', timestamp: 1 }];
    appendInstructionToHistory(history, '补充', 'n1');
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('任务\n\n补充');

    const blocks: Message[] = [{ id: 'u0', role: 'user', content: [{ type: 'text', text: '任务' }], timestamp: 1 }];
    appendInstructionToHistory(blocks, '补充', 'n2');
    expect(blocks[0].content).toEqual([{ type: 'text', text: '任务' }, { type: 'text', text: '补充' }]);

    const afterAssistant: Message[] = [
      { id: 'u0', role: 'user', content: '任务', timestamp: 1 },
      { id: 'a0', role: 'assistant', content: '好的', timestamp: 2 },
    ];
    appendInstructionToHistory(afterAssistant, '补充', 'n3');
    expect(afterAssistant).toHaveLength(3);
    expect(afterAssistant[2]).toMatchObject({ id: 'n3', role: 'user', content: '补充' });
  });
});
