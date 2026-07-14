import { describe, it, expect, beforeEach } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { collectAndZip } from './bundle';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import type { ConversationMeta } from '@/core/session/conversationStorage';

function makeMessage(id: string, text: string): Message {
  return { id, role: 'user', content: text, timestamp: Date.now() };
}

function makeConversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [makeMessage(`${id}-m0`, 'hello')],
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
    messageCount: 1,
  };
}

describe('collectAndZip (诊断反馈增强 L1: 二进制截图打包)', () => {
  const conv = makeConversation('conv-zzzzzzzz-9999');

  beforeEach(() => {
    useChatStore.setState({
      conversations: { [conv.id]: conv },
      conversationIndex: { [conv.id]: makeMeta(conv.id) },
      activeConversationId: conv.id,
    });
  });

  it('zips binary screenshot entries alongside text entries, round-tripping exact bytes', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const { bytes } = await collectAndZip({
      includeRawText: true,
      conversationIds: [conv.id],
      description: 'repro steps here',
      screenshots: [{ name: '01.png', bytes: pngBytes }],
    });

    const unzipped = unzipSync(bytes);

    // Text entry decodes back to the original string.
    expect(strFromU8(unzipped['feedback/description.txt'])).toBe('repro steps here');

    // Binary entry round-trips byte-for-byte.
    const screenshotOut = unzipped['feedback/screenshots/01.png'];
    expect(screenshotOut).toBeInstanceOf(Uint8Array);
    expect(Array.from(screenshotOut)).toEqual(Array.from(pngBytes));
  });

  it('uses a multi-N short id in the filename when several conversations are selected', async () => {
    const conv2 = makeConversation('conv-yyyyyyyy-8888');
    useChatStore.setState((s: ReturnType<typeof useChatStore.getState>) => ({
      conversations: { ...s.conversations, [conv2.id]: conv2 },
      conversationIndex: { ...s.conversationIndex, [conv2.id]: makeMeta(conv2.id) },
    }));

    const { filename } = await collectAndZip({
      includeRawText: true,
      conversationIds: [conv.id, conv2.id],
    });

    expect(filename).toMatch(/^abu-diagnostic-multi-2-/);
  });

  it('uses "global" in the filename when no conversation is selected and none is active', async () => {
    useChatStore.setState({ activeConversationId: null });

    const { filename } = await collectAndZip({
      includeRawText: true,
      conversationIds: [],
    });

    expect(filename).toMatch(/^abu-diagnostic-global-/);
  });

  it('F1 regression: filename stays "global" (not the active conversation) when conversationIds is explicitly empty, even though an active conversation IS set — and the zip embeds no conversation content either', async () => {
    // activeConversationId is `conv.id` here (see beforeEach) — before the
    // fix, bundle.ts re-derived the id set independently from collect.ts and
    // could disagree with it (filename says "active", content says "none",
    // or vice versa). Both must now agree via the shared resolveConversationIds.
    const { bytes, filename } = await collectAndZip({
      includeRawText: true,
      conversationIds: [],
    });

    expect(filename).toMatch(/^abu-diagnostic-global-/);

    const unzipped = unzipSync(bytes);
    const perConversationEntries = Object.keys(unzipped).filter(
      (f) => f.startsWith('conversations/') && f !== 'conversations/index.json',
    );
    expect(perConversationEntries).toHaveLength(0);
  });
});
