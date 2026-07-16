import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  capDiagnosticMessages,
  DEFAULT_DIAGNOSTIC_MESSAGE_CAP,
  MAX_TOTAL_DIAGNOSTIC_MESSAGES,
  collectBundleFiles,
  resolveConversationIds,
} from './collect';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import type { ConversationMeta } from '@/core/session/conversationStorage';

function makeMessage(id: string, text: string): Message {
  return { id, role: 'user', content: text, timestamp: Date.now() };
}

function makeConversation(id: string, messageCount = 2): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: Array.from({ length: messageCount }, (_, i) => makeMessage(`${id}-m${i}`, `hello ${i}`)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
  };
}

function makeMeta(id: string): ConversationMeta {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 2,
  };
}

describe('capDiagnosticMessages (Bug 2: 导出诊断包冻死)', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}` }));

  it('keeps only the last N messages when over the cap, reporting the total', () => {
    const r = capDiagnosticMessages(many, 200);
    expect(r.capped).toBe(true);
    expect(r.total).toBe(250);
    expect(r.messages).toHaveLength(200);
    expect(r.messages[0].id).toBe('m50');       // dropped the oldest 50
    expect(r.messages[199].id).toBe('m249');    // kept the most recent
  });

  it('returns everything untouched when under the cap', () => {
    const few = many.slice(0, 10);
    const r = capDiagnosticMessages(few, 200);
    expect(r.capped).toBe(false);
    expect(r.total).toBe(10);
    expect(r.messages).toBe(few);               // same reference — no copy
  });

  it("'all' disables the cap even for huge conversations", () => {
    const r = capDiagnosticMessages(many, 'all');
    expect(r.capped).toBe(false);
    expect(r.messages).toHaveLength(250);
  });

  it('cap 0 embeds NO messages (not everything — slice(-0) trap)', () => {
    const r = capDiagnosticMessages(many, 0);
    expect(r.messages).toHaveLength(0);
    expect(r.total).toBe(250);
    expect(r.capped).toBe(true);
  });

  it('has a sane default cap', () => {
    expect(DEFAULT_DIAGNOSTIC_MESSAGE_CAP).toBe(100);
  });
});

describe('collectBundleFiles (诊断反馈增强 L1: 多选对话 / 描述 / 截图)', () => {
  const convA = makeConversation('conv-aaaaaaaa-1111');
  const convB = makeConversation('conv-bbbbbbbb-2222');
  const convC = makeConversation('conv-cccccccc-3333');

  beforeEach(() => {
    useChatStore.setState({
      conversations: { [convA.id]: convA, [convB.id]: convB, [convC.id]: convC },
      conversationIndex: {
        [convA.id]: makeMeta(convA.id),
        [convB.id]: makeMeta(convB.id),
        [convC.id]: makeMeta(convC.id),
      },
      activeConversationId: convA.id,
    });
  });

  it('embeds only the selected conversations when conversationIds has multiple entries', async () => {
    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [convA.id, convB.id],
    });

    const shortA = convA.id.slice(0, 8);
    const shortB = convB.id.slice(0, 8);
    const shortC = convC.id.slice(0, 8);

    expect(files[`conversations/${shortA}/messages.jsonl`]).toBeDefined();
    expect(files[`conversations/${shortB}/messages.jsonl`]).toBeDefined();
    expect(files[`conversations/${shortA}/index-entry.json`]).toBeDefined();
    expect(files[`conversations/${shortB}/index-entry.json`]).toBeDefined();
    // C was not selected — must not appear
    expect(files[`conversations/${shortC}/messages.jsonl`]).toBeUndefined();
  });

  it('produces no conversations/<id>/ content when conversationIds is empty and there is no active conversation, but still writes environment files', async () => {
    useChatStore.setState({ activeConversationId: null });

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [],
    });

    const perConversationFiles = Object.keys(files).filter(
      (f) => f.startsWith('conversations/') && f !== 'conversations/index.json',
    );
    expect(perConversationFiles).toHaveLength(0);

    // Environment / meta files are unaffected.
    expect(files['meta.json']).toBeDefined();
    expect(files['diagnostic-snapshot.json']).toBeDefined();
    expect(files['conversations/index.json']).toBeDefined();
  });

  it('writes feedback/description.txt with the trimmed description, and omits it when blank', async () => {
    const withDesc = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [],
      description: '  这是一段描述文字  ',
    });
    expect(withDesc.files['feedback/description.txt']).toBe('这是一段描述文字');

    const withoutDesc = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [],
      description: '   ',
    });
    expect(withoutDesc.files['feedback/description.txt']).toBeUndefined();
  });

  it('embeds screenshots as raw Uint8Array entries under feedback/screenshots/', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic bytes
    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [],
      screenshots: [{ name: '01.png', bytes }],
    });

    const entry = files['feedback/screenshots/01.png'];
    expect(entry).toBeInstanceOf(Uint8Array);
    expect(entry).toEqual(bytes);
  });

  it('applies the message cap independently per conversation', async () => {
    const big = makeConversation('conv-dddddddd-4444', 10);
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversations: { ...s.conversations, [big.id]: big },
      conversationIndex: { ...s.conversationIndex, [big.id]: makeMeta(big.id) },
    }));

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [convA.id, big.id],
      messageCap: 3,
    });

    const shortA = convA.id.slice(0, 8);
    const shortBig = big.id.slice(0, 8);

    // convA has 2 messages (under cap) — no truncation note.
    expect(files[`conversations/${shortA}/_truncation-note.txt`]).toBeUndefined();
    const aLines = (files[`conversations/${shortA}/messages.jsonl`] as string).split('\n');
    expect(aLines).toHaveLength(2);

    // big has 10 messages (over cap of 3) — capped + truncation note.
    expect(files[`conversations/${shortBig}/_truncation-note.txt`]).toBeDefined();
    const bigLines = (files[`conversations/${shortBig}/messages.jsonl`] as string).split('\n');
    expect(bigLines).toHaveLength(3);
  });
});

describe('resolveConversationIds (F1: empty conversationIds must never fall through to active)', () => {
  it('respects an explicit empty array — never falls back to the active conversation', () => {
    expect(resolveConversationIds({ conversationIds: [] }, 'active-id')).toEqual([]);
  });

  it('respects an explicit non-empty array, deduped', () => {
    expect(resolveConversationIds({ conversationIds: ['a', 'b', 'a'] }, 'active-id')).toEqual(['a', 'b']);
  });

  it('falls back to conversationId when conversationIds is undefined', () => {
    expect(resolveConversationIds({ conversationId: 'legacy-id' }, 'active-id')).toEqual(['legacy-id']);
  });

  it('an explicit conversationIds takes priority over the legacy conversationId', () => {
    expect(resolveConversationIds({ conversationIds: ['x'], conversationId: 'legacy-id' }, 'active-id')).toEqual([
      'x',
    ]);
  });

  it('falls back to the active conversation when neither conversationIds nor conversationId is given', () => {
    expect(resolveConversationIds({}, 'active-id')).toEqual(['active-id']);
  });

  it('returns [] when nothing is provided and there is no active conversation', () => {
    expect(resolveConversationIds({}, null)).toEqual([]);
  });
});

describe('collectBundleFiles — F1/F2/F3 review-flagged regressions', () => {
  const convA = makeConversation('conv-aaaaaaaa-1111');
  const convB = makeConversation('conv-bbbbbbbb-2222');
  // Capture the store's real loadConversation once, so tests that stub it
  // (F2) can't leak the stub into later tests.
  const realLoadConversation = useChatStore.getState().loadConversation;

  beforeEach(() => {
    useChatStore.setState({
      conversations: { [convA.id]: convA, [convB.id]: convB },
      conversationIndex: {
        [convA.id]: makeMeta(convA.id),
        [convB.id]: makeMeta(convB.id),
      },
      activeConversationId: convA.id,
      loadConversation: realLoadConversation,
    });
  });

  afterEach(() => {
    useChatStore.setState({ loadConversation: realLoadConversation });
  });

  it('F1: an explicit empty conversationIds does NOT fall back to the active conversation, even though one is set', async () => {
    // Pre-fix behaviour: `opts.conversationIds.length > 0` was false for
    // `[]`, so it fell through to `activeConversationId` (convA here) and
    // silently re-attached a conversation the user had explicitly
    // unchecked — a privacy leak. activeConversationId is deliberately
    // non-null in this test (unlike the pre-existing empty-selection test,
    // which used a null active id and therefore could not have caught this).
    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [],
    });

    const perConversationFiles = Object.keys(files).filter(
      (f) => f.startsWith('conversations/') && f !== 'conversations/index.json',
    );
    expect(perConversationFiles).toHaveLength(0);
    const shortA = convA.id.slice(0, 8);
    expect(files[`conversations/${shortA}/messages.jsonl`]).toBeUndefined();
  });

  it('F2: lazily loads a selected conversation that is only in conversationIndex, not yet in conversations', async () => {
    const lazyConv = makeConversation('conv-eeeeeeee-5555', 3);
    // Only register it in the index — NOT in `conversations` — simulating a
    // conversation from an earlier session never opened this run.
    const loadConversationSpy = vi.fn(async (id: string) => {
      if (id !== lazyConv.id) return;
      useChatStore.setState((state: ReturnType<typeof useChatStore.getState>) => ({
        conversations: { ...state.conversations, [lazyConv.id]: lazyConv },
      }));
    });
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversationIndex: { ...s.conversationIndex, [lazyConv.id]: makeMeta(lazyConv.id) },
      loadConversation: loadConversationSpy,
    }));

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [lazyConv.id],
    });

    expect(loadConversationSpy).toHaveBeenCalledWith(lazyConv.id);
    const shortId = lazyConv.id.slice(0, 8);
    expect(files[`conversations/${shortId}/messages.jsonl`]).toBeDefined();
    const lines = (files[`conversations/${shortId}/messages.jsonl`] as string).split('\n');
    expect(lines).toHaveLength(3);
  });

  it('F2: an already-loaded conversation is embedded WITHOUT calling loadConversation', async () => {
    const loadConversationSpy = vi.fn(async () => {});
    useChatStore.setState({ loadConversation: loadConversationSpy });

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [convA.id],
    });

    expect(loadConversationSpy).not.toHaveBeenCalled();
    const shortA = convA.id.slice(0, 8);
    expect(files[`conversations/${shortA}/messages.jsonl`]).toBeDefined();
  });

  it('F2: still drops the conversation gracefully when loadConversation cannot populate it', async () => {
    const ghostId = 'conv-ffffffff-0000000000';
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversationIndex: { ...s.conversationIndex, [ghostId]: makeMeta(ghostId) },
      // Mirrors chatStore's real loadConversation, which never throws even
      // on failure — it just leaves `conversations[id]` unpopulated.
      loadConversation: vi.fn(async () => {}),
    }));

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [ghostId],
    });

    const shortId = ghostId.slice(0, 8);
    expect(files[`conversations/${shortId}/messages.jsonl`]).toBeUndefined();
  });

  it('F3: a global message budget clamps total embedded messages when messageCap is "all" across multiple conversations', async () => {
    // 3 conversations × 400 messages = 1200 total > MAX_TOTAL_DIAGNOSTIC_MESSAGES (1000).
    const big1 = makeConversation('conv-11111111-a', 400);
    const big2 = makeConversation('conv-22222222-b', 400);
    const big3 = makeConversation('conv-33333333-c', 400);
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversations: { ...s.conversations, [big1.id]: big1, [big2.id]: big2, [big3.id]: big3 },
      conversationIndex: {
        ...s.conversationIndex,
        [big1.id]: makeMeta(big1.id),
        [big2.id]: makeMeta(big2.id),
        [big3.id]: makeMeta(big3.id),
      },
    }));

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: [big1.id, big2.id, big3.id],
      messageCap: 'all',
    });

    const totalLines = [big1, big2, big3]
      .map((c) => c.id.slice(0, 8))
      .reduce((sum, shortId) => {
        const content = files[`conversations/${shortId}/messages.jsonl`] as string | undefined;
        if (!content) return sum;
        return sum + content.split('\n').filter(Boolean).length;
      }, 0);

    // Total across all conversations is clamped to the global budget, even
    // though 'all' would otherwise remove any per-conversation limit.
    expect(totalLines).toBeLessThanOrEqual(MAX_TOTAL_DIAGNOSTIC_MESSAGES);
    expect(totalLines).toBe(MAX_TOTAL_DIAGNOSTIC_MESSAGES);

    // The last conversation to be processed should carry a truncation note
    // that specifically calls out the global budget (not just the
    // per-conversation cap message).
    const short3 = big3.id.slice(0, 8);
    const note3 = files[`conversations/${short3}/_truncation-note.txt`] as string;
    expect(note3).toBeDefined();
    expect(note3).toMatch(/budget/);
  });

  it('F3: the global budget binds across many conversations even when each per-conversation cap would fit', async () => {
    // 6 conversations × 300 messages each, per-conv cap 300, so without a
    // global budget the sum would be 6 × 300 = 1800 > 1000.
    // Ids are given distinct first-8-char prefixes (digit at index 5) so
    // each gets its own un-collided short id inside the bundle.
    const many = Array.from({ length: 6 }, (_, i) => makeConversation(`conv-${i}-mmmmmmmm`, 300));
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversations: { ...s.conversations, ...Object.fromEntries(many.map((c) => [c.id, c])) },
      conversationIndex: {
        ...s.conversationIndex,
        ...Object.fromEntries(many.map((c) => [c.id, makeMeta(c.id)])),
      },
    }));

    const { files } = await collectBundleFiles({
      includeRawText: true,
      conversationIds: many.map((c) => c.id),
      messageCap: 300, // above the default; the global budget must still clamp the aggregate.
    });

    const totalLines = many.reduce((sum, c) => {
      const shortId = c.id.slice(0, 8);
      const content = files[`conversations/${shortId}/messages.jsonl`] as string | undefined;
      if (!content) return sum;
      return sum + content.split('\n').filter(Boolean).length;
    }, 0);

    expect(totalLines).toBeLessThanOrEqual(MAX_TOTAL_DIAGNOSTIC_MESSAGES);
  });

  // message-storage P1 step 4: authoritativeTotal
  describe('authoritativeTotal (windowed conversations)', () => {
    it('reports the authoritative total when the in-memory array is a partial window', () => {
      // Only 150 messages loaded in memory (a window), but the catalog knows
      // the conversation really has 500. Cap is 200.
      const window = Array.from({ length: 150 }, (_, i) => ({ id: `w${i}` }));
      const r = capDiagnosticMessages(window, 200, 500);
      // total must reflect the authoritative count, not the window length.
      expect(r.total).toBe(500);
      // We only had 150 in memory, all kept, but it's capped relative to history.
      expect(r.messages).toHaveLength(150);
      expect(r.capped).toBe(true);
    });

    it('keeps the last N and reports authoritative total when the window itself exceeds the cap', () => {
      const window = Array.from({ length: 250 }, (_, i) => ({ id: `w${i}` }));
      const r = capDiagnosticMessages(window, 200, 900);
      expect(r.total).toBe(900);
      expect(r.messages).toHaveLength(200);
      expect(r.messages[0].id).toBe('w50');
      expect(r.capped).toBe(true);
    });

    it('falls back to messages.length when authoritativeTotal is omitted', () => {
      const window = Array.from({ length: 250 }, (_, i) => ({ id: `w${i}` }));
      const r = capDiagnosticMessages(window, 200);
      expect(r.total).toBe(250);
    });

    it('falls back to messages.length when authoritativeTotal is undefined', () => {
      const few = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}` }));
      const r = capDiagnosticMessages(few, 200, undefined);
      expect(r.total).toBe(10);
      expect(r.capped).toBe(false);
    });
  });
});
