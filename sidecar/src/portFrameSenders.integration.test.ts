// @vitest-environment happy-dom
/**
 * Sender → applier round trip: the frames a sidecar run emits through
 * `createFrameChatDelta` (write-through into the run mirror, media transport
 * barrier included) are applied to the REAL shell chatStore in arrival order,
 * exactly as `agentLoopRunner.ts`'s `agent.delta` handler does.
 *
 * Pins the answer-after-image-tool-result path: an image result opens the
 * media transport barrier, the next model turn's assistant message and its
 * streamed tokens queue behind it, and the shell must still render the
 * streamed text exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useScratchpadStore } from '@/stores/scratchpadStore';
import type { Conversation, Message, ToolResultContent } from '@/types';

const delegatedMediaStoreMocks = vi.hoisted(() => ({
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
}));

vi.mock('@/core/subagent/delegatedMediaStore', () => delegatedMediaStoreMocks);

const replaceMessageByIdMock = vi.fn().mockResolvedValue(undefined);
const snapshotMessageRevisionMock = vi.fn().mockResolvedValue(undefined);
// Partial mock (importOriginal): chatStore.ts dynamically imports this same
// module for the index/catalog writers that createConversation()/addMessage()
// use, so only the two checkpoint writers are replaced.
vi.mock('@/core/session/conversationStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/session/conversationStorage')>();
  return {
    ...actual,
    replaceMessageById: (...a: unknown[]) => replaceMessageByIdMock(...a),
    snapshotMessageRevision: (...a: unknown[]) => snapshotMessageRevisionMock(...a),
  };
});

// agentLoopRunner.ts self-registers into this module at import time (pulled
// in transitively by frameApplier's store imports); stub it so that side
// effect no-ops here.
vi.mock('@/core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: () => true,
  registerSidecarRunPredicate: () => {},
}));

import { applyDeltaFrames } from '@/core/agent/frameApplier';
import { createFrameChatDelta } from './portFrameSenders';
import { createConversationRunMirror } from './conversationRunMirror';
import type { PortFrame } from './portFrameCoalescer';

// Filler timestamp (TESTING.md §3) — not asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

const imageResult: ToolResultContent[] = [
  { type: 'text', text: 'Image: probe.png (1280x720)' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
];

function seedConversation(convId: string): Conversation {
  return {
    id: convId,
    title: 'round trip',
    messages: [],
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    status: 'idle',
  };
}

describe('portFrameSenders → frameApplier round trip', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      pendingInputAppend: null,
      agentStates: new Map(),
    });
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useScratchpadStore.setState({ entries: {}, order: [] });
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReset();
    delegatedMediaStoreMocks.readDelegatedMedia.mockReset();
    replaceMessageByIdMock.mockClear();
    snapshotMessageRevisionMock.mockClear();
  });

  it('renders the streamed answer exactly once when the answer message queues behind an image tool result', async () => {
    let resolvePersist!: (ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void;
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
      new Promise((resolve) => { resolvePersist = resolve; }),
    );
    const convId = useChatStore.getState().createConversation();
    const mirror = createConversationRunMirror(convId, { conversation: seedConversation(convId) });
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame), mirror.applyChatDeltaWrite);

    // Tool turn: the image result opens the media transport barrier.
    delta.updateToolCall(convId, 'm-tool', 'tc-1', 'Image: probe.png (1280x720)', imageResult, false);

    // Answer turn: starts while the image is still being persisted, so every
    // frame below waits behind the barrier while the mirror keeps applying
    // the same writes to its own copy.
    const answer: Message = {
      id: 'm-answer',
      role: 'assistant',
      content: '',
      timestamp: FIXED_TIMESTAMP,
      isStreaming: true,
    };
    delta.addMessage(convId, answer);
    delta.appendText(convId, 'hello ', 'm-answer');
    delta.appendText(convId, 'world', 'm-answer');
    delta.finishStreaming(convId, 'm-answer');

    resolvePersist({
      id: 'media_round_trip',
      sha256: 'b'.repeat(64),
      mediaType: 'image/png',
      bytes: 8,
    });
    await delta.drain();
    expect(frames.map((frame) => frame.m)).toEqual([
      'updateToolCall',
      'addMessage',
      'appendText',
      'appendText',
      'finishStreaming',
    ]);

    await applyDeltaFrames(frames);

    const stored = useChatStore.getState().conversations[convId]?.messages.find((m) => m.id === 'm-answer');
    expect(stored?.content).toBe('hello world');
    expect(stored?.isStreaming).toBe(false);
    // The mirror's own copy converged on the same text.
    expect(mirror.reader.getConversation(convId)?.messages.find((m) => m.id === 'm-answer')?.content)
      .toBe('hello world');
  });
});
