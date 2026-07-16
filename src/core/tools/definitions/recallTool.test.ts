import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { recallTool } from './recallTool';
import { useChatStore } from '../../../stores/chatStore';
import type { ConversationMeta } from '../../session/conversationStorage';

// message-storage P1 step 3: the recall tool's conversation listing is the
// real display consumer of ConversationMeta.messageCount (there is no sidebar
// message-count display). For conversations NOT currently loaded in memory it
// PREFERS the catalog's authoritative count, falling back to the optimistic
// index count only when the catalog is unavailable. For conversations that
// ARE loaded in memory it prefers the in-memory index count instead —
// code-review fix #6: after an edit/retry truncates conv.messages in memory,
// the append-only JSONL is not rewritten, so the catalog's reindexed count
// re-inflates to include the removed messages; preferring the catalog for a
// loaded conversation would then report a stale, too-high count for the very
// conversation being displayed.

function meta(overrides: Partial<ConversationMeta> & { id: string }): ConversationMeta {
  return {
    title: 'Untitled',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

describe('recallTool — conversation count display (P1 step 3)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
    });
  });

  it('prefers the catalog authoritative count over the optimistic index count', async () => {
    // Index (optimistic, possibly a windowed understatement) says 5; the
    // catalog (authoritative) says 500. Display must show 500.
    useChatStore.setState({
      conversationIndex: {
        'conv-win': meta({ id: 'conv-win', title: 'Windowed chat', messageCount: 5, updatedAt: 100 }),
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'catalog_get_conversation') {
        const a = args as { convId: string };
        if (a.convId === 'conv-win') return { conv_id: 'conv-win', message_count: 500 };
      }
      return undefined;
    });

    const out = (await recallTool.execute({ query: '' }, undefined)) as string;
    expect(out).toContain('Windowed chat');
    expect(out).toContain('500');
    expect(out).not.toContain('(5 '); // the optimistic count must not be rendered
  });

  it('falls back to the optimistic index count when the catalog returns null', async () => {
    useChatStore.setState({
      conversationIndex: {
        'conv-fb': meta({ id: 'conv-fb', title: 'Fallback chat', messageCount: 7, updatedAt: 200 }),
      },
    });
    // Catalog has no row for this conversation.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'catalog_get_conversation') return null;
      return undefined;
    });

    const out = (await recallTool.execute({ query: '' }, undefined)) as string;
    expect(out).toContain('Fallback chat');
    expect(out).toContain('7');
  });

  it('applies the >= 2 gate on the optimistic index count (write timing unchanged)', async () => {
    useChatStore.setState({
      conversationIndex: {
        'conv-tiny': meta({ id: 'conv-tiny', title: 'One-message chat', messageCount: 1, updatedAt: 300 }),
      },
    });
    // Even if the catalog would report a larger count, the coarse pre-load gate
    // filters on the optimistic index value, so this conversation is excluded.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'catalog_get_conversation') return { conv_id: 'conv-tiny', message_count: 99 };
      return undefined;
    });

    const out = (await recallTool.execute({ query: '' }, undefined)) as string;
    expect(out).not.toContain('One-message chat');
  });

  it('prefers the accurate in-memory count over an inflated catalog count when the conversation is loaded (code-review fix #6)', async () => {
    // Simulate: user edited/retried mid-conversation. chatStore truncated
    // conv.messages in memory to 30 (and re-derived conversationIndex to
    // match — see addMessage's messageCount re-derivation), but the
    // append-only JSONL was never rewritten. At the next turn-end reindex,
    // catalogReindexConversation re-derives message_count from the JSONL
    // line count, re-inflating it back up to 50. The catalog is stale/wrong
    // here — the loaded in-memory count (30) is the truth.
    useChatStore.setState({
      conversationIndex: {
        'conv-loaded': meta({ id: 'conv-loaded', title: 'Edited chat', messageCount: 30, updatedAt: 400 }),
      },
      conversations: {
        'conv-loaded': {
          id: 'conv-loaded',
          title: 'Edited chat',
          messages: Array.from({ length: 30 }, (_, i) => ({
            id: `m${i}`,
            role: 'user' as const,
            content: 'x',
            timestamp: i,
          })),
          createdAt: 1,
          updatedAt: 400,
        } as unknown as ReturnType<typeof useChatStore.getState>['conversations'][string],
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'catalog_get_conversation') {
        const a = args as { convId: string };
        if (a.convId === 'conv-loaded') return { conv_id: 'conv-loaded', message_count: 50 };
      }
      return undefined;
    });

    const out = (await recallTool.execute({ query: '' }, undefined)) as string;
    expect(out).toContain('Edited chat');
    expect(out).toContain('30');
    expect(out).not.toContain('50'); // must NOT relay the inflated catalog count
  });
});
