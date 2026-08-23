// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useScratchpadStore } from '@/stores/scratchpadStore';
import { invoke } from '@tauri-apps/api/core';

const replaceMessageByIdMock = vi.fn().mockResolvedValue(undefined);
const snapshotMessageRevisionMock = vi.fn().mockResolvedValue(undefined);
// Partial mock (importOriginal) — chatStore.ts dynamically imports this SAME
// resolved module (via a different relative specifier, '../core/session/
// conversationStorage') for several other exports (updateIndexEntry,
// catalogUpsertConversation, ...) used by createConversation()/addMessage()
// in the ordering/allowlist tests below; a full replacement mock would break
// those unrelated calls with "no export defined on the mock".
vi.mock('../session/conversationStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session/conversationStorage')>();
  return {
    ...actual,
    replaceMessageById: (...a: unknown[]) => replaceMessageByIdMock(...a),
    snapshotMessageRevision: (...a: unknown[]) => snapshotMessageRevisionMock(...a),
  };
});

// P1-3c-1 — forced "true" so the cancelStreaming-frame test below proves the
// frame path bypasses chatStore.cancelStreaming's own sidecar-run gate (see
// that action's doc): a real sidecar's cancelStreaming frame typically
// arrives while its RunSession still reads as active, so the special case in
// applyChatFrame below must apply the decoration regardless.
vi.mock('./sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: () => true,
  // agentLoopRunner.ts self-registers into this module at import time (it's
  // pulled in transitively by other core modules in this test's import
  // graph) — stub it out so that side effect no-ops against this mock.
  registerSidecarRunPredicate: () => {},
}));

import { applyDeltaFrames, type PortFrame } from './frameApplier';

// Filler timestamp (TESTING.md §3) — not asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

describe('applyDeltaFrames', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      pendingInputAppend: null,
      thinkingStartTime: null,
    });
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useScratchpadStore.setState({ entries: {}, order: [] });
    replaceMessageByIdMock.mockClear();
    snapshotMessageRevisionMock.mockClear();
  });

  describe('chat frames', () => {
    it('dispatches addMessage to the real chatStore', async () => {
      const convId = useChatStore.getState().createConversation();
      await applyDeltaFrames([
        {
          p: 'chat',
          m: 'addMessage',
          a: [convId, { id: 'm1', role: 'user', content: 'hi', timestamp: FIXED_TIMESTAMP }],
        },
      ]);
      expect(useChatStore.getState().conversations[convId].messages[0].id).toBe('m1');
    });

    it('dispatches appendText + flushTokens to the real chatStore', async () => {
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      await applyDeltaFrames([
        { p: 'chat', m: 'appendText', a: [convId, 'hello', 'a1'] },
        { p: 'chat', m: 'flushTokens', a: [convId, 'a1'] },
      ]);
      expect(useChatStore.getState().conversations[convId].messages[0].content).toBe('hello');
    });

    it('cancelStreaming frame applies the full "stopped" decoration even though isConversationRunningInSidecar reads true (P1-3c-1)', async () => {
      // This module's top-of-file mock forces isConversationRunningInSidecar
      // to always return true — the real-world state while this frame is
      // being applied (see chatStore.ts's cancelStreaming doc). A naive
      // generic dispatch (chatStore.cancelStreaming(convId) with no opts)
      // would see "sidecar run active" and skip the decoration entirely;
      // applyChatFrame's special case must pass fromSidecarFrame: true to
      // bypass that gate, so the marker still lands.
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      await applyDeltaFrames([{ p: 'chat', m: 'cancelStreaming', a: [convId] }]);
      const msg = useChatStore.getState().conversations[convId].messages[0];
      expect(msg.content).toBe('部分输出');
      expect(msg.stopReason).toBe('user');
      expect(msg.isStreaming).toBe(false);
    });

    it('setExecutionStepsSnapshot frame grafts SHELL-side child steps missing from the sidecar snapshot', async () => {
      // A sidecar-run loop's snapshot comes from ITS execution mirror, which
      // never saw the child steps the shell EventRouter created for a
      // delegate's subagent tools (delegate_to_agent executes shell-side).
      // The applier must merge them in before the snapshot is stored, or the
      // whole child timeline — subagent images included — vanishes on replay.
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop-1',
      });
      // Shell-side execution state, exactly as agentLoopRunner's shell
      // EventRouter would have built it during the run.
      await applyDeltaFrames([
        { p: 'exec', m: 'createExecution', a: [convId, 'loop-1'] },
        {
          p: 'exec',
          m: 'addStep',
          a: ['loop-1', { id: 'step-delegate', executionId: 'loop-1', type: 'delegate', label: 'Delegate', status: 'running', toolName: 'delegate_to_agent', toolInput: {}, source: 'agent', detailBlocks: [] }],
        },
      ]);
      useTaskExecutionStore.getState().addChildStep('loop-1', 'step-delegate', {
        id: 'child-1', executionId: 'loop-1', toolCallId: 'toolu_sub_1', type: 'tool', label: 'Screenshot',
        status: 'completed', toolName: 'computer', toolInput: {}, source: 'agent',
        detailBlocks: [{ id: 'child-1-image', stepId: 'child-1', type: 'image', label: 'Image', content: 'Image: /tmp/s.png', isTruncated: false, isExpanded: true }],
      });

      // The sidecar's snapshot: bare delegate step, no childSteps.
      await applyDeltaFrames([
        {
          p: 'chat',
          m: 'setExecutionStepsSnapshot',
          a: [convId, 'loop-1', [{ id: 'step-delegate', toolCallId: 'tc-d', type: 'delegate', label: 'Delegate', status: 'completed', toolName: 'delegate_to_agent' }]],
        },
      ]);

      const stored = useChatStore.getState().conversations[convId].messages[0].executionSteps;
      expect(stored).toHaveLength(1);
      expect(stored![0].childSteps).toHaveLength(1);
      expect(stored![0].childSteps![0]).toMatchObject({
        id: 'child-1',
        toolCallId: 'toolu_sub_1',
        toolName: 'computer',
      });
      expect(stored![0].childSteps![0].detailBlocks?.[0]).toMatchObject({ id: 'child-1-image', type: 'image' });
    });

    it('setExecutionStepsSnapshot frame leaves a snapshot untouched when it already carries child steps', async () => {
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop-1',
      });
      const snapWithChildren = [{
        id: 'step-delegate', type: 'delegate' as const, label: 'Delegate', status: 'completed' as const, toolName: 'delegate_to_agent',
        childSteps: [{ id: 'child-authoritative', type: 'tool' as const, label: 'X', status: 'completed' as const, toolName: 'computer' }],
      }];
      await applyDeltaFrames([
        { p: 'chat', m: 'setExecutionStepsSnapshot', a: [convId, 'loop-1', snapWithChildren] },
      ]);
      const stored = useChatStore.getState().conversations[convId].messages[0].executionSteps;
      expect(stored![0].childSteps![0].id).toBe('child-authoritative');
    });
  });

  describe('exec frames', () => {
    it('createExecution frame uses id === loopId (id-preserving apply)', async () => {
      await applyDeltaFrames([{ p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-42'] }]);
      const exec = useTaskExecutionStore.getState().executions['loop-42'];
      expect(exec).toBeDefined();
      expect(exec?.id).toBe('loop-42');
      expect(exec?.loopId).toBe('loop-42');
      expect(exec?.conversationId).toBe('conv-1');
    });

    it('addStep frame dispatches onto the execution created by an earlier createExecution frame', async () => {
      await applyDeltaFrames([
        { p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] },
        {
          p: 'exec',
          m: 'addStep',
          a: ['loop-1', { id: 'step-1', executionId: 'loop-1', type: 'tool', label: 'l', status: 'running', toolName: 't', toolInput: {}, source: 'agent', detailBlocks: [] }],
        },
      ]);
      expect(useTaskExecutionStore.getState().executions['loop-1'].steps).toHaveLength(1);
    });

    it('does not expose getExecutionByLoopId/getExecutionByConversationId as applicable frame methods (read methods rejected as unknown)', async () => {
      await expect(
        applyDeltaFrames([{ p: 'exec', m: 'getExecutionByLoopId', a: ['loop-1'] }]),
      ).resolves.not.toThrow();
      // No execution should have been created/mutated by this call.
      expect(Object.keys(useTaskExecutionStore.getState().executions)).toHaveLength(0);
    });
  });

  describe('scratchpad frames', () => {
    it('addEntry frame preserves the sidecar-supplied id', async () => {
      await applyDeltaFrames([
        {
          p: 'scratchpad',
          m: 'addEntry',
          a: ['sidecar-id-1', { conversationId: 'conv-1', title: 't', type: 'summary', content: 'c' }],
        },
      ]);
      expect(useScratchpadStore.getState().entries['sidecar-id-1']).toMatchObject({
        id: 'sidecar-id-1',
        conversationId: 'conv-1',
        content: 'c',
      });
    });
  });

  describe('session frames', () => {
    it('replaceMessageById frame dynamically imports and calls conversationStorage.replaceMessageById', async () => {
      const message = { id: 'm1', role: 'assistant' as const, content: 'x', timestamp: FIXED_TIMESTAMP };
      await applyDeltaFrames([{ p: 'session', m: 'replaceMessageById', a: ['conv-1', message] }]);
      expect(replaceMessageByIdMock).toHaveBeenCalledWith('conv-1', message);
    });

    it('does not let a session replacement overtake an earlier chat append', async () => {
      let releaseAppend!: () => void;
      const appendPending = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'append_file_text') await appendPending;
        return undefined;
      });

      try {
        const convId = useChatStore.getState().createConversation();
        const message = {
          id: 'ordered-frame-1',
          role: 'assistant' as const,
          content: 'final',
          timestamp: FIXED_TIMESTAMP,
        };
        const applying = applyDeltaFrames([
          { p: 'chat', m: 'addMessage', a: [convId, { ...message, content: '' }] },
          { p: 'session', m: 'replaceMessageById', a: [convId, message] },
        ]);

        await Promise.resolve();
        await Promise.resolve();
        expect(replaceMessageByIdMock).not.toHaveBeenCalled();

        releaseAppend();
        await applying;
        expect(replaceMessageByIdMock).toHaveBeenCalledWith(convId, message);
      } finally {
        vi.mocked(invoke).mockReset();
      }
    });

    it('snapshotMessageRevision frame dynamically imports and calls conversationStorage.snapshotMessageRevision', async () => {
      const message = { id: 'm1', role: 'assistant' as const, content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true };
      await applyDeltaFrames([{ p: 'session', m: 'snapshotMessageRevision', a: ['conv-1', message] }]);
      expect(snapshotMessageRevisionMock).toHaveBeenCalledWith('conv-1', message);
      expect(replaceMessageByIdMock).not.toHaveBeenCalled();
    });

    it('does not let a snapshot write overtake pending chat-append persistence (a pending checkpoint would drop the fresher snapshot entry when it lands)', async () => {
      let releaseAppend!: () => void;
      const appendPending = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'append_file_text') await appendPending;
        return undefined;
      });

      try {
        const convId = useChatStore.getState().createConversation();
        const message = {
          id: 'snap-frame-1',
          role: 'assistant' as const,
          content: 'partial',
          timestamp: FIXED_TIMESTAMP,
          isStreaming: true,
        };
        const applying = applyDeltaFrames([
          { p: 'chat', m: 'addMessage', a: [convId, { ...message, content: '' }] },
          { p: 'session', m: 'snapshotMessageRevision', a: [convId, message] },
        ]);

        await Promise.resolve();
        await Promise.resolve();
        expect(snapshotMessageRevisionMock).not.toHaveBeenCalled();

        releaseAppend();
        await applying;
        expect(snapshotMessageRevisionMock).toHaveBeenCalledWith(convId, message);
      } finally {
        vi.mocked(invoke).mockReset();
      }
    });

    it('unknown session method is skipped, not dispatched', async () => {
      await applyDeltaFrames([{ p: 'session', m: 'deleteEverything', a: ['conv-1'] }]);
      expect(replaceMessageByIdMock).not.toHaveBeenCalled();
      expect(snapshotMessageRevisionMock).not.toHaveBeenCalled();
    });
  });

  describe('ordering', () => {
    it('applies frames strictly in array order, even across ports', async () => {
      const convId = useChatStore.getState().createConversation();
      const calls: string[] = [];
      const origAddMessage = useChatStore.getState().addMessage;
      useChatStore.setState({
        addMessage: (...args: Parameters<typeof origAddMessage>) => {
          calls.push('chat:addMessage');
          return origAddMessage(...args);
        },
      });

      const frames: PortFrame[] = [
        { p: 'chat', m: 'addMessage', a: [convId, { id: 'm1', role: 'user', content: 'a', timestamp: FIXED_TIMESTAMP }] },
        { p: 'exec', m: 'createExecution', a: [convId, 'loop-order'] },
        { p: 'scratchpad', m: 'addEntry', a: ['sp-1', { conversationId: convId, title: 't', type: 'summary', content: 'c' }] },
      ];
      await applyDeltaFrames(frames);

      expect(calls).toEqual(['chat:addMessage']);
      expect(useChatStore.getState().conversations[convId].messages[0].id).toBe('m1');
      expect(useTaskExecutionStore.getState().executions['loop-order']).toBeDefined();
      expect(useScratchpadStore.getState().entries['sp-1']).toBeDefined();
    });
  });

  describe('unknown-frame skip (forward-compat)', () => {
    it('unknown port is skipped without throwing, and does not affect any store', async () => {
      await expect(
        applyDeltaFrames([{ p: 'bogus-port' as unknown as PortFrame['p'], m: 'whatever', a: [] }]),
      ).resolves.not.toThrow();
    });

    it('unknown chat method is skipped without throwing', async () => {
      const convId = useChatStore.getState().createConversation();
      await expect(
        applyDeltaFrames([{ p: 'chat', m: 'doesNotExist', a: [convId] }]),
      ).resolves.not.toThrow();
    });

    it('unknown exec method is skipped without throwing', async () => {
      await expect(
        applyDeltaFrames([{ p: 'exec', m: 'doesNotExist', a: [] }]),
      ).resolves.not.toThrow();
    });

    it('unknown scratchpad method is skipped without throwing', async () => {
      await expect(
        applyDeltaFrames([{ p: 'scratchpad', m: 'doesNotExist', a: [] }]),
      ).resolves.not.toThrow();
      expect(Object.keys(useScratchpadStore.getState().entries)).toHaveLength(0);
    });

    it('a batch continues past an unknown frame — subsequent valid frames still apply', async () => {
      const convId = useChatStore.getState().createConversation();
      await applyDeltaFrames([
        { p: 'chat', m: 'doesNotExist', a: [convId] },
        { p: 'chat', m: 'addMessage', a: [convId, { id: 'm1', role: 'user', content: 'a', timestamp: FIXED_TIMESTAMP }] },
      ]);
      expect(useChatStore.getState().conversations[convId].messages[0].id).toBe('m1');
    });
  });

  describe('allowlist rejection', () => {
    it('rejects a chat frame naming a method not on the ChatDelta interface, even if it happens to exist as a store action name elsewhere', async () => {
      // 'createConversation' is a real chatStore action but NOT part of ChatDelta's
      // allowlisted surface — must be rejected, not reflected into getChatDelta().
      await expect(
        applyDeltaFrames([{ p: 'chat', m: 'createConversation', a: [] }]),
      ).resolves.not.toThrow();
      expect(Object.keys(useChatStore.getState().conversations)).toHaveLength(0);
    });
  });
});
