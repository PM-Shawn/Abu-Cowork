import { describe, expect, it, vi } from 'vitest';
import { createSubagentController } from './subagentAbort';
import { requestDispatchInput } from './dispatchCancel';
import { acknowledgeDispatchInstruction, drainDispatchInstructionEntries, takeUnconfirmedInstructions, takeDeliveredInstructions } from './dispatchInput';
vi.mock('@/core/sidecar/sidecarManager', () => ({ notifySidecar: vi.fn() }));

describe('dispatch instruction receipt (F5)', () => {
  it('sending an instruction does not assert that the member consumed it', () => {
    const run = createSubagentController('A', undefined, 'receipt:0');
    try {
      requestDispatchInput('receipt:0', 'user correction');
      expect(takeDeliveredInstructions('receipt:0')).toEqual([]);
    } finally { run.cleanup(); takeUnconfirmedInstructions('receipt:0'); }
  });
  it('requires exact consumption receipts and returns unsent/unconfirmed instructions at settle', () => {
    expect(requestDispatchInput('inactive:0', 'no owner')).toBe(false);
    const run = createSubagentController('A', undefined, 'ack:0');
    try {
      expect(requestDispatchInput('ack:0', 'same text')).toBe(true);
      expect(requestDispatchInput('ack:0', 'same text')).toBe(true);
      const entries = drainDispatchInstructionEntries('ack:0');
      expect(entries).toHaveLength(2);
      expect(entries[0].id).not.toBe(entries[1].id);
      acknowledgeDispatchInstruction('foreign:0', entries[0].id);
      acknowledgeDispatchInstruction('ack:0', 'unknown-id');
      expect(takeDeliveredInstructions('ack:0')).toEqual([]);
      acknowledgeDispatchInstruction('ack:0', entries[0].id);
      acknowledgeDispatchInstruction('ack:0', entries[0].id);
      expect(takeDeliveredInstructions('ack:0')).toEqual(['same text']);
      run.cleanup();
      expect(takeUnconfirmedInstructions('ack:0')).toEqual(['same text']);
      expect(takeUnconfirmedInstructions('ack:0')).toEqual([]);
    } finally { run.cleanup(); }
  });

});
