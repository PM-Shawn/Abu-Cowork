// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import {
  useChatStore,
  flushTokenBuffer,
  sanitizeLoadedMessages,
  sanitizeImportedMessage,
  collectAnsweredLoopIds,
  waitForConversationPersistence,
} from './chatStore';
import type { Conversation } from '../types';
import { createDocReference } from '@/types/chatReference';
import { foldMessageLog } from '@/core/session/messageLedger';
import { getI18n } from '../i18n';
import {
  clearAllComposerDrafts,
  getComposerDraftKey,
  registerComposerDraftResourceDisposer,
  useComposerDraftStore,
  writeComposerDraft,
  writePersistedComposerText,
} from './composerDraftStore';
import { DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST } from '@/core/session/durableToolResultContent';
import { useBatchProgressStore } from './batchProgressStore';
import { subagentTabId, usePreviewStore } from './previewStore';
import { makeBatchKey } from '@/types';

// Stable workspace store mock — Task #34 regression tests need to assert
// that clearWorkspace is NOT called on start/switch flows, so the fn
// instances must persist across getState() calls.
const mockSetWorkspace = vi.fn();
const mockClearWorkspace = vi.fn();
vi.mock('./workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      setWorkspace: mockSetWorkspace,
      clearWorkspace: mockClearWorkspace,
    }),
    subscribe: vi.fn(),
  },
}));

// Project store mock — createConversation auto-associates the new conv
// with any project whose workspacePath matches (regression for welcome-
// page "create project → first message lands in 最近 instead of project").
const mockGetProjectByWorkspace = vi.fn<(ws: string) => { id: string; name: string } | undefined>();
vi.mock('./projectStore', () => ({
  useProjectStore: {
    getState: () => ({ getProjectByWorkspace: mockGetProjectByWorkspace }),
  },
}));

// P1-3c-1 — cancelStreaming's sidecar-run gate reads this predicate (see
// sidecarRunPredicate.ts's cycle-breaking doc for why chatStore.ts imports
// it instead of agentLoopRunner.ts directly). Defaults to false (no active
// sidecar run) so every PRE-EXISTING cancelStreaming test below — none of
// which know about sidecar runs — keeps exercising the original direct
// path unchanged; only the new 'sidecar run authority' describe block below
// flips it true.
const mockIsConversationRunningInSidecar = vi.fn<(convId: string) => boolean>();
vi.mock('../core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: (convId: string) => mockIsConversationRunningInSidecar(convId),
  // agentLoopRunner.ts self-registers into this module at import time (it's
  // pulled in transitively by other core modules in this test's import
  // graph) — stub it out so that side effect no-ops against this mock.
  registerSidecarRunPredicate: () => {},
}));

// Filler timestamp (TESTING.md §3) — used for Message/Conversation fields that
// are structurally required but whose exact value is never asserted on below
// (no test in this file compares timestamps for ordering/recency).
const FIXED_TIMESTAMP = 1_700_000_000_000;

describe('chatStore', () => {
  beforeEach(() => {
    usePreviewStore.getState().closeAllTabs();
    for (const entry of Object.values(useBatchProgressStore.getState().batches)) {
      useBatchProgressStore.getState().clearBatch(entry.identity);
    }
    clearAllComposerDrafts();
    mockSetWorkspace.mockClear();
    mockClearWorkspace.mockClear();
    mockGetProjectByWorkspace.mockReset();
    mockGetProjectByWorkspace.mockReturnValue(undefined);
    mockIsConversationRunningInSidecar.mockReset();
    mockIsConversationRunningInSidecar.mockReturnValue(false);
    useChatStore.setState({
      conversations: {},
      // conversationIndex must reset alongside conversations: deleteConversation
      // now uses the index (not the conversations map) to compute the successor
      // active conv after deleting the active one, so leftover index entries
      // from earlier tests would leak across cases.
      conversationIndex: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      pendingInputAppend: null,
      agentStates: new Map(),
    });
  });

  // ── createConversation ──
  describe('createConversation', () => {
    it('creates a conversation and sets it active', () => {
      const id = useChatStore.getState().createConversation();
      const state = useChatStore.getState();
      expect(state.conversations[id]).toBeDefined();
      expect(state.conversations[id].title).toBe(getI18n().chatDefaults.newConversationTitle);
      expect(state.activeConversationId).toBe(id);
    });

    it('creates conversation with workspace path', () => {
      const id = useChatStore.getState().createConversation('/Users/test/project');
      expect(useChatStore.getState().conversations[id].workspacePath).toBe('/Users/test/project');
    });

    it('auto-associates projectId when workspace matches a project', () => {
      // Regression: welcome-page flow after "create project → first message"
      // used to land the conversation in 最近 because createConversation was
      // called with only a workspace path. The lookup now runs inside
      // createConversation so every entry point (ChatView, schedule, IM)
      // benefits without plumbing projectId through each caller.
      mockGetProjectByWorkspace.mockReturnValue({ id: 'proj-123', name: 'DA' });
      const id = useChatStore.getState().createConversation('/Users/test/da');
      expect(mockGetProjectByWorkspace).toHaveBeenCalledWith('/Users/test/da');
      expect(useChatStore.getState().conversations[id].projectId).toBe('proj-123');
    });

    it('leaves projectId undefined when no project matches', () => {
      mockGetProjectByWorkspace.mockReturnValue(undefined);
      const id = useChatStore.getState().createConversation('/Users/test/orphan');
      expect(useChatStore.getState().conversations[id].projectId).toBeUndefined();
    });

    it('respects explicit options.projectId over auto-lookup', () => {
      mockGetProjectByWorkspace.mockReturnValue({ id: 'proj-auto', name: 'A' });
      const id = useChatStore.getState().createConversation('/Users/test/x', {
        projectId: 'proj-explicit',
      });
      // Auto-lookup must not run when caller already knows the project.
      // Schedule/trigger/IM invocations pass projectId explicitly and
      // expect their value to win even if the workspace happens to match
      // a different project entry.
      expect(useChatStore.getState().conversations[id].projectId).toBe('proj-explicit');
    });

    it('skips project lookup when workspace is null', () => {
      useChatStore.getState().createConversation(null);
      expect(mockGetProjectByWorkspace).not.toHaveBeenCalled();
    });
  });

  // ── startNewConversation ──
  describe('startNewConversation', () => {
    it('sets activeConversationId to null', () => {
      useChatStore.getState().createConversation();
      useChatStore.getState().startNewConversation();
      expect(useChatStore.getState().activeConversationId).toBeNull();
    });

    it('clears the global workspace (top-level "新建任务" = fresh start)', () => {
      // Mental model: top-level "新建任务" is "step out of current project
      // context". No ambient workspace leak into the new task. If agent
      // needs workspace later it'll call request_workspace (orchestrator
      // workspace-hint + Task #37 hint chain).
      useChatStore.getState().createConversation();
      useChatStore.getState().startNewConversation();
      expect(mockClearWorkspace).toHaveBeenCalled();
    });
  });

  // ── switchConversation ──
  describe('switchConversation', () => {
    it('switches active conversation', async () => {
      const id1 = useChatStore.getState().createConversation();
      useChatStore.getState().createConversation();
      await useChatStore.getState().switchConversation(id1);
      expect(useChatStore.getState().activeConversationId).toBe(id1);
    });

    it('applies target conv workspace when bound', async () => {
      const id = useChatStore.getState().createConversation('/Users/test/bound');
      await useChatStore.getState().switchConversation(id);
      expect(mockSetWorkspace).toHaveBeenCalledWith('/Users/test/bound');
    });

    it('clears workspace when target conv has no binding', async () => {
      // Users expect each conversation to track with its own workspace.
      // Switching to an unbound conv with stale ambient workspace would
      // confuse the user ("why is my project still showing?"). Clearing
      // here makes conv ↔ workspace relationship predictable; the earlier
      // "tool lost workspace mid-session" cascade is defended by the
      // b2b69c6 / ffeb7cb / 4ba56d3 patches downstream.
      const id = useChatStore.getState().createConversation(); // no workspace arg
      await useChatStore.getState().switchConversation(id);
      expect(mockClearWorkspace).toHaveBeenCalled();
    });
  });

  // ── deleteConversation ──
  describe('deleteConversation', () => {
    it('deletes a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().deleteConversation(id);
      expect(useChatStore.getState().conversations[id]).toBeUndefined();
    });

    it('cascades subagent tab leases and batch entries for the deleted conversation only', () => {
      const deletedId = useChatStore.getState().createConversation();
      const survivorId = useChatStore.getState().createConversation();
      const deletedBatch = { conversationId: deletedId, batchToolCallId: 'shared-batch' };
      const survivorBatch = { conversationId: survivorId, batchToolCallId: 'shared-batch' };
      const batchStore = useBatchProgressStore.getState();
      batchStore.initBatch(deletedBatch, ['Deleted worker']);
      batchStore.initBatch(survivorBatch, ['Surviving worker']);
      const deletedTab = usePreviewStore.getState().openSubagent(deletedBatch, 0, 'Deleted worker');
      const survivorTab = usePreviewStore.getState().openSubagent(survivorBatch, 0, 'Surviving worker');
      usePreviewStore.getState().activateTab(deletedTab);
      expect(useBatchProgressStore.getState().batches[makeBatchKey(deletedBatch)]?.viewLeaseCount).toBe(1);

      useChatStore.getState().deleteConversation(deletedId);

      expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([survivorTab]);
      expect(usePreviewStore.getState().tabs).not.toContainEqual(
        expect.objectContaining({ id: subagentTabId(deletedBatch, 0) }),
      );
      expect(useBatchProgressStore.getState().batches[makeBatchKey(deletedBatch)]).toBeUndefined();
      expect(useBatchProgressStore.getState().batches[makeBatchKey(survivorBatch)]).toBeDefined();
    });

    it('does not resurrect deleted batch state when in-flight progress settles late', async () => {
      const conversationId = useChatStore.getState().createConversation();
      const identity = {
        conversationId,
        assistantMessageId: 'assistant-in-flight',
        batchToolCallId: 'batch-in-flight',
      };
      const batchStore = useBatchProgressStore.getState();
      batchStore.initBatch(identity, ['In-flight worker']);
      batchStore.setTaskRunning(identity, 0);
      usePreviewStore.getState().openSubagent(identity, 0, 'In-flight worker');

      useChatStore.getState().deleteConversation(conversationId);
      await Promise.resolve();
      batchStore.setTaskActivity(identity, 0, 'late activity', 1);
      batchStore.startTaskStep(identity, 0, {
        id: 'late-tool',
        toolName: 'read_file',
        toolInput: { path: '/late' },
      });
      batchStore.finishTaskStep(identity, 0, {
        id: 'late-tool',
        toolName: 'read_file',
        result: 'late result',
        resultContent: [{ type: 'text', text: 'late result' }],
        error: false,
      });
      batchStore.setTaskTerminal(identity, 0, { status: 'succeeded', reason: 'completed' });

      expect(useBatchProgressStore.getState().batches[makeBatchKey(identity)]).toBeUndefined();
      expect(usePreviewStore.getState().tabs).not.toContainEqual(
        expect.objectContaining({ id: subagentTabId(identity, 0) }),
      );
    });

    it('clears the deleted conversation draft', () => {
      const id = useChatStore.getState().createConversation();
      const draftKey = getComposerDraftKey(id);
      writePersistedComposerText(draftKey, 'do not orphan this draft');

      useChatStore.getState().deleteConversation(id);

      expect(useComposerDraftStore.getState().drafts[draftKey]).toBeUndefined();
    });

    it('disposes token resources held by the deleted conversation draft', () => {
      const dispose = vi.fn();
      const unregister = registerComposerDraftResourceDisposer(dispose);
      const id = useChatStore.getState().createConversation();
      const draftKey = getComposerDraftKey(id);
      writeComposerDraft(draftKey, {
        text: '',
        images: [],
        files: [{ id: 'pdf', token: 'trusted-token', name: 'plan.pdf' }],
        references: [],
        selectedSkill: null,
        selectedAgent: null,
      });

      useChatStore.getState().deleteConversation(id);

      expect(dispose).toHaveBeenCalledWith({
        kind: 'file-token',
        token: 'trusted-token',
        file: { id: 'pdf', token: 'trusted-token', name: 'plan.pdf' },
      });
      unregister();
    });

    it('switches to another conversation when active is deleted', async () => {
      const id1 = useChatStore.getState().createConversation();
      const id2 = useChatStore.getState().createConversation();
      await useChatStore.getState().switchConversation(id2);
      useChatStore.getState().deleteConversation(id2);
      // Should fallback to remaining conversation
      const state = useChatStore.getState();
      expect(state.activeConversationId).toBe(id1);
    });

    /**
     * Direct seed of conversations + conversationIndex with controlled
     * createdAt so neighbour-by-position assertions are deterministic.
     * Mirrors the shape created by createConversation but bypasses Date.now().
     */
    function seedConvs(items: Array<{
      id: string;
      createdAt: number;
      projectId?: string;
      scheduledTaskId?: string;
      triggerId?: string;
    }>) {
      type ConvShape = Record<string, unknown>;
      const conversations: Record<string, ConvShape> = {};
      const conversationIndex: Record<string, ConvShape> = {};
      for (const item of items) {
        const meta: ConvShape = {
          id: item.id,
          title: `Conv ${item.id}`,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          messageCount: 0,
          ...(item.projectId ? { projectId: item.projectId } : {}),
          ...(item.scheduledTaskId ? { scheduledTaskId: item.scheduledTaskId } : {}),
          ...(item.triggerId ? { triggerId: item.triggerId } : {}),
        };
        conversations[item.id] = { ...meta, messages: [], status: 'idle' };
        conversationIndex[item.id] = meta;
      }
      // setState typing is intentionally loose for fixture seeding
      useChatStore.setState({
        conversations: conversations as never,
        conversationIndex: conversationIndex as never,
      });
    }

    describe('focus movement after delete (B3)', () => {
      it('moves focus to prev (newer) neighbour when deleting middle conversation', () => {
        // Visual order desc: d (newest), c, b, a (oldest)
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
          { id: 'c', createdAt: 3000 },
          { id: 'd', createdAt: 4000 },
        ]);
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // Deleting b: prev (above b in UI) = c
        expect(useChatStore.getState().activeConversationId).toBe('c');
      });

      it('falls back to next (older) when deleting the topmost conversation', () => {
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // b is newest, no prev → next = a
        expect(useChatStore.getState().activeConversationId).toBe('a');
      });

      it('returns null when deleting the only conversation in scope', () => {
        seedConvs([{ id: 'a', createdAt: 1000 }]);
        useChatStore.setState({ activeConversationId: 'a' });
        useChatStore.getState().deleteConversation('a');
        expect(useChatStore.getState().activeConversationId).toBeNull();
      });

      it('stays within the same project scope', () => {
        // recent r1, r2 + project p1, p2
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'r2', createdAt: 4000 }, // newest in recent
          { id: 'p1', createdAt: 2000, projectId: 'proj-1' },
          { id: 'p2', createdAt: 3000, projectId: 'proj-1' }, // newest in project
        ]);
        useChatStore.setState({ activeConversationId: 'p2' });
        useChatStore.getState().deleteConversation('p2');
        // proj-1 sorted: p2, p1. Deleting p2 → no prev, next = p1.
        // Must not jump to r2 even though r2 is newer overall.
        expect(useChatStore.getState().activeConversationId).toBe('p1');
      });

      it('returns null when project has only the deleted conversation', () => {
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'p1', createdAt: 2000, projectId: 'proj-1' },
        ]);
        useChatStore.setState({ activeConversationId: 'p1' });
        useChatStore.getState().deleteConversation('p1');
        // proj-1 empty after delete → null, NOT pulled into recent (r1)
        expect(useChatStore.getState().activeConversationId).toBeNull();
      });

      it('does not change active when deleting a non-active conversation', () => {
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        useChatStore.setState({ activeConversationId: 'a' });
        useChatStore.getState().deleteConversation('b');
        expect(useChatStore.getState().activeConversationId).toBe('a');
      });

      it('keeps automation conversations isolated from regular pool', () => {
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'r2', createdAt: 2000 },
          { id: 's1', createdAt: 3000, scheduledTaskId: 'task-1' },
          { id: 's2', createdAt: 4000, scheduledTaskId: 'task-1' },
        ]);
        useChatStore.setState({ activeConversationId: 's1' });
        useChatStore.getState().deleteConversation('s1');
        // s1 / s2 in same scheduled scope; sorted: s2, s1. Deleting s1: prev = s2.
        // Should not jump to r2.
        expect(useChatStore.getState().activeConversationId).toBe('s2');
      });

      it('clears notice badge for deleted and successor conversations', async () => {
        const { useNoticeBadgeStore } = await import('./noticeBadgeStore');
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        // Plant pre-existing badges on both convs
        useNoticeBadgeStore.setState({ counts: { a: 3, b: 1, other: 5 } });
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // Wait for the dynamic import().then() badge clears to settle
        await new Promise((r) => setTimeout(r, 0));
        const counts = useNoticeBadgeStore.getState().counts;
        // Deleted conv's badge gone (no orphan entries on a non-existent conv)
        expect(counts.b).toBeUndefined();
        // Successor conv (a) badge cleared — focus moved there, so it's now "viewed"
        expect(counts.a).toBeUndefined();
        // Unrelated conv badge untouched
        expect(counts.other).toBe(5);
      });
    });
  });

  // ── deleteConversation — ordered abort for live sidecar runs (P1-3c-2) ──
  // Design doc §3 change 3 / P1-3C-SCOUT-REPORT.md §5 "secondary finding":
  // deleteConversation must fire the abort (which reaches a live sidecar run
  // via the SAME AbortController agentLoopRunner.ts wires into onShellAbort)
  // BEFORE erasing conversations[id]/conversationIndex[id], so the sidecar
  // gets the stop signal as early as possible. Verified this ordering
  // already existed pre-3c-2 (no reorder was needed) — these tests lock it
  // in as a regression guard.
  describe('deleteConversation — ordered abort (P1-3c-2)', () => {
    it('aborts the active controller BEFORE the conversation record is erased', () => {
      const id = useChatStore.getState().createConversation();
      // getAbortController lazily creates-and-registers a controller in the
      // SAME module-level Map deleteConversation reads from — this is what
      // "a live sidecar run" looks like from chatStore's perspective (see
      // agentLoopRunner.ts's runAgentLoopDispatched, which registers into
      // this exact map via getAbortRegistry().getAbortController()).
      const controller = useChatStore.getState().getAbortController(id);
      let conversationPresentDuringAbort: boolean | undefined;
      const abortSpy = vi.spyOn(controller, 'abort').mockImplementation(() => {
        conversationPresentDuringAbort = id in useChatStore.getState().conversations;
      });

      useChatStore.getState().deleteConversation(id);

      expect(abortSpy).toHaveBeenCalledTimes(1);
      // The conversation record must still exist AT THE MOMENT abort() runs
      // — proves abort fires before the delete, not after/racing it.
      expect(conversationPresentDuringAbort).toBe(true);
      expect(useChatStore.getState().conversations[id]).toBeUndefined();
      expect(useChatStore.getState().conversationIndex[id]).toBeUndefined();
      expect(useChatStore.getState().hasAbortController(id)).toBe(false);
    });

    it('no active controller: deletes cleanly, behavior unchanged', () => {
      const id = useChatStore.getState().createConversation();
      expect(useChatStore.getState().hasAbortController(id)).toBe(false);

      expect(() => useChatStore.getState().deleteConversation(id)).not.toThrow();

      expect(useChatStore.getState().conversations[id]).toBeUndefined();
      expect(useChatStore.getState().hasAbortController(id)).toBe(false);
    });
  });

  // ── renameConversation ──
  describe('renameConversation', () => {
    it('renames a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().renameConversation(id, '测试对话');
      expect(useChatStore.getState().conversations[id].title).toBe('测试对话');
    });

    // message-storage hybrid P2 (live freshness): a rename must be searchable
    // immediately, not only after the next startup reconcile. The store
    // reaches catalogReindexConversation via a dynamic import (module-level
    // vi.mock can't intercept it), so — same pattern as the catalog_bump_count
    // assertions above — we assert at the invoke('catalog_reindex_conversation')
    // layer.
    it('fires a live-freshness catalog reindex after renaming', async () => {
      const id = useChatStore.getState().createConversation();
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      useChatStore.getState().renameConversation(id, '新标题');

      await vi.waitFor(() => {
        const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
        expect(reindex).toBeDefined();
        expect((reindex![1] as { convId: string }).convId).toBe(id);
      });
    });

    // Fix #4: catalogReindexConversation must fire AFTER updateIndexEntry's
    // own index flush lands the new title on disk — not concurrently — so
    // the Rust-side reindex never races updateIndexEntry's indexCache
    // mutation and reads a stale title. Asserted the same way as the
    // ordering check in conversationStorage.test.ts's catalogReindexConversation
    // suite: the index.json write must precede the reindex invoke.
    it('reindexes only after the renamed title has been flushed to index.json', async () => {
      const id = useChatStore.getState().createConversation();
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      useChatStore.getState().renameConversation(id, '排序新标题');

      await vi.waitFor(() => {
        const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
        expect(reindex).toBeDefined();
      });

      const calls = vi.mocked(invoke).mock.calls;
      const indexWriteIdx = calls.findIndex(
        (c) =>
          c[0] === 'atomic_write_text' &&
          typeof (c[1] as { path?: string } | undefined)?.path === 'string' &&
          (c[1] as { path: string }).path.includes('index.json'),
      );
      const reindexIdx = calls.findIndex((c) => c[0] === 'catalog_reindex_conversation');
      expect(indexWriteIdx).toBeGreaterThanOrEqual(0);
      expect(indexWriteIdx).toBeLessThan(reindexIdx);
    });
  });

  // ── addMessage ──
  describe('addMessage', () => {
    it('adds a message to conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Hello', timestamp: FIXED_TIMESTAMP,
      });
      const conv = useChatStore.getState().conversations[id];
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].content).toBe('Hello');
    });

    it('persists Reliable Run Protocol lifecycle and route metadata on the existing user message', async () => {
      const id = useChatStore.getState().createConversation();
      const message = {
        id: 'client-msg-1',
        role: 'user',
        content: '/writer draft',
        timestamp: FIXED_TIMESTAMP,
        runId: 'run-1',
        clientMessageId: 'client-msg-1',
        runState: 'pending',
      } as const;
      useChatStore.getState().addMessage(id, message);
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

      try {
        useChatStore.getState().updateUserMessageRun(id, 'client-msg-1', {
          state: 'accepted',
          content: 'draft',
          skill: { name: 'writer', description: 'Write documents' },
        });
        await waitForConversationPersistence(id);

        expect(useChatStore.getState().conversations[id].messages[0]).toMatchObject({
          id: 'client-msg-1',
          content: 'draft',
          runState: 'accepted',
          runId: 'run-1',
          clientMessageId: 'client-msg-1',
          skill: { name: 'writer' },
        });
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
      }
    });

    it('keeps structured upstream error details on the durable failed user row', async () => {
      const terminalTimestamp = new Date('2026-08-29T00:00:00.000Z').getTime();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(terminalTimestamp);
      const id = useChatStore.getState().createConversation();
      const message = {
        id: 'client-msg-upstream-failure',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: FIXED_TIMESTAMP,
        runState: 'running',
      } as const;
      const errorDetails = {
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'store-trace-403',
        summary: 'The content safety system rejected the request.',
      } as const;
      useChatStore.getState().addMessage(id, message);
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

      try {
        useChatStore.getState().updateUserMessageRun(id, message.id, {
          state: 'failed',
          error: errorDetails.summary,
          errorDetails,
        });
        await waitForConversationPersistence(id);

        expect(useChatStore.getState().conversations[id].messages[0]).toMatchObject({
          runState: 'failed',
          runError: errorDetails.summary,
          runErrorDetails: errorDetails,
          runEndedAt: terminalTimestamp,
        });
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
        nowSpy.mockRestore();
      }
    });

    it('rejects privacy-unsafe upstream fields at the store action boundary', async () => {
      const id = useChatStore.getState().createConversation();
      const message = {
        id: 'client-msg-unsafe-upstream',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: FIXED_TIMESTAMP,
        runState: 'running',
      } as const;
      useChatStore.getState().addMessage(id, message);
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

      try {
        useChatStore.getState().updateUserMessageRun(id, message.id, {
          state: 'failed',
          error: 'HTTP 403 · content_policy',
          errorDetails: {
            status: 403,
            rawBody: 'private prompt text',
          } as never,
        });
        await waitForConversationPersistence(id);

        const stored = useChatStore.getState().conversations[id].messages[0];
        expect(stored.runError).toBe('HTTP 403 · content_policy');
        expect(stored.runErrorDetails).toBeUndefined();
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
      }
    });

    it('sanitizes a structured run error at the store action boundary', async () => {
      const id = useChatStore.getState().createConversation();
      const message = {
        id: 'client-msg-unsafe-run-error',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: FIXED_TIMESTAMP,
        runState: 'running',
      } as const;
      useChatStore.getState().addMessage(id, message);
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

      try {
        useChatStore.getState().updateUserMessageRun(id, message.id, {
          state: 'failed',
          error: '{"private":"provider body at store boundary"}',
        });
        await waitForConversationPersistence(id);

        const stored = useChatStore.getState().conversations[id].messages[0];
        expect(stored.runError).toBe(getI18n().chat.errorEmptyBody);
        expect(JSON.stringify(stored)).not.toContain('provider body at store boundary');
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
      }
    });

    it('drops failure fields when the store action completes a run', async () => {
      const id = useChatStore.getState().createConversation();
      const message = {
        id: 'client-msg-completed-with-error',
        role: 'user',
        content: 'fixed fixture input',
        timestamp: FIXED_TIMESTAMP,
        runState: 'running',
      } as const;
      useChatStore.getState().addMessage(id, message);
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

      try {
        useChatStore.getState().updateUserMessageRun(id, message.id, {
          state: 'completed',
          error: 'must not survive',
          errorDetails: { status: 403 },
        });
        await waitForConversationPersistence(id);

        const stored = useChatStore.getState().conversations[id].messages[0];
        expect(stored.runState).toBe('completed');
        expect(stored.runError).toBeUndefined();
        expect(stored.runErrorDetails).toBeUndefined();
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
      }
    });

    it('persists a terminal timestamp with the interrupted reliable-run state', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-13T06:30:00.000Z'));
      const id = 'conv-interrupted-terminal';
      const message = {
        id: 'client-msg-stopped',
        role: 'user',
        content: 'inspect my desktop',
        timestamp: 1_000,
        runState: 'running',
      } as const;
      useChatStore.setState({
        conversations: {
          [id]: {
            id,
            title: 'Stopped task',
            messages: [message],
            createdAt: 1_000,
            updatedAt: 1_000,
            status: 'running',
          },
        },
        conversationIndex: {
          [id]: {
            id,
            title: 'Stopped task',
            createdAt: 1_000,
            updatedAt: 1_000,
            messageCount: 1,
          },
        },
      });
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);
      vi.mocked(invoke).mockResolvedValue(undefined);

      try {
        useChatStore.getState().updateUserMessageRun(id, message.id, { state: 'interrupted' });
        // The strict replacement is an append now, so it settles on the write
        // queue's 100 ms drain rather than writing inline — under fake timers
        // that drain has to be driven explicitly.
        const persisted = waitForConversationPersistence(id);
        await vi.advanceTimersByTimeAsync(200);
        await persisted;

        expect(useChatStore.getState().conversations[id].messages[0]).toMatchObject({
          runState: 'interrupted',
          runEndedAt: new Date('2026-08-13T06:30:00.000Z').getTime(),
        });
      } finally {
        vi.useRealTimers();
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
        vi.mocked(invoke).mockReset();
      }
    });

    it('exposes a durability barrier for the asynchronous JSONL append', async () => {
      let releaseAppend!: () => void;
      const appendPending = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'append_file_text') await appendPending;
        return undefined;
      });

      try {
        const id = useChatStore.getState().createConversation();
        useChatStore.getState().addMessage(id, {
          id: 'barrier-1',
          role: 'assistant',
          content: 'durable answer',
          timestamp: FIXED_TIMESTAMP,
        });

        let settled = false;
        const barrier = waitForConversationPersistence(id).finally(() => {
          settled = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseAppend();
        await barrier;
        expect(settled).toBe(true);
      } finally {
        vi.mocked(invoke).mockReset();
      }
    });

    it('rejects the durability barrier when every append path fails', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('disk unavailable'));
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'barrier-failure-1',
        role: 'user',
        content: 'must not execute',
        timestamp: FIXED_TIMESTAMP,
      });

      await expect(waitForConversationPersistence(id)).rejects.toThrow('disk unavailable');
      vi.mocked(invoke).mockReset();
    });

    it('auto-titles from first user message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: '帮我写一个函数', timestamp: FIXED_TIMESTAMP,
      });
      const title = useChatStore.getState().conversations[id].title;
      expect(title).toContain('帮我写一个函数');
    });

    it('truncates long auto-titles to 30 chars', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'x'.repeat(50), timestamp: FIXED_TIMESTAMP,
      });
      const title = useChatStore.getState().conversations[id].title;
      expect(title.length).toBeLessThanOrEqual(34); // 30 + "..."
    });

    it('re-derives conversationIndex.messageCount from conv.messages.length on each append', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      expect(store.conversationIndex[id].messageCount).toBe(0);
      store.addMessage(id, { id: 'm1', role: 'user', content: 'a', timestamp: 1 });
      store.addMessage(id, { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 });
      store.addMessage(id, { id: 'm3', role: 'user', content: 'c', timestamp: 3 });
      expect(useChatStore.getState().conversationIndex[id].messageCount).toBe(3);
    });

    // Regression (code-review fix #1, message-storage P0): messageCount must be
    // RE-DERIVED from conv.messages.length, not incremented. deleteMessagesFrom
    // mutates conv.messages but never touches conversationIndex.messageCount
    // itself, so an increment-only counter would drift upward forever across
    // truncates/edits/retries. Re-derivation self-heals.
    it('messageCount self-heals across a truncate: add 4, truncate from m2, add 1 → 2 (not 6)', async () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, { id: 'm1', role: 'user', content: 'a', timestamp: 1 });
      store.addMessage(id, { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 });
      store.addMessage(id, { id: 'm3', role: 'user', content: 'c', timestamp: 3 });
      store.addMessage(id, { id: 'm4', role: 'assistant', content: 'd', timestamp: 4 });
      expect(useChatStore.getState().conversationIndex[id].messageCount).toBe(4);
      // Drain every addMessage's disk append before truncating, and drain the
      // truncate's own disk write before the test returns — deleteMessagesFrom
      // is durably persisted now (plan stage 3), so leaving it unawaited would
      // let its real 100ms-debounced write land during a LATER test instead.
      await waitForConversationPersistence(id);

      // Removes m2, m3, m4 — keeping m1.
      useChatStore.getState().deleteMessagesFrom(id, 'm2');
      await waitForConversationPersistence(id);

      useChatStore.getState().addMessage(id, { id: 'm5', role: 'user', content: 'e', timestamp: 5 });
      expect(useChatStore.getState().conversations[id].messages).toHaveLength(2);
      expect(useChatStore.getState().conversationIndex[id].messageCount).toBe(2);
      await waitForConversationPersistence(id);
    });
  });

  // ── appendToLastMessage ──
  describe('appendToLastMessage', () => {
    it('appends token to last message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'assistant', content: 'Hello', timestamp: FIXED_TIMESTAMP,
      });
      useChatStore.getState().appendToLastMessage(id, ' World');
      // Tokens are buffered via RAF; flush to apply immediately in test
      flushTokenBuffer(id);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.content).toBe('Hello World');
    });

    // Regression: mid-stream user input bug. ChatInput adds a user message to the
    // store while a turn is still streaming → that user msg becomes the new "last
    // message". Without explicit msgId routing, subsequent assistant tokens would
    // get appended into the user bubble.
    it('routes tokens by msgId so a mid-stream user message is not corrupted', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'user-1', role: 'user', content: 'first', timestamp: FIXED_TIMESTAMP,
      });
      store.addMessage(id, {
        id: 'assistant-1', role: 'assistant', content: 'Hello', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      // User sends another message mid-stream — now last message is user-2.
      store.addMessage(id, {
        id: 'user-2', role: 'user', content: 'second', timestamp: FIXED_TIMESTAMP,
      });
      // Streaming token should still land on assistant-1, not user-2.
      store.appendToLastMessage(id, ' World', 'assistant-1');
      flushTokenBuffer(id, 'assistant-1');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-1')?.content).toBe('Hello World');
      expect(msgs.find((m) => m.id === 'user-2')?.content).toBe('second');
    });

    it('flushTokenBuffer drains the per-msgId buffer not the convId fallback', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'assistant-a', role: 'assistant', content: 'A', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      store.addMessage(id, {
        id: 'user-x', role: 'user', content: 'tail', timestamp: FIXED_TIMESTAMP,
      });
      store.appendToLastMessage(id, '+1', 'assistant-a');
      store.appendToLastMessage(id, '+2', 'assistant-a');
      flushTokenBuffer(id, 'assistant-a');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-a')?.content).toBe('A+1+2');
      expect(msgs.find((m) => m.id === 'user-x')?.content).toBe('tail');
    });
  });

  // ── updateMessageThinking / updateMessageThinkingDuration (F: thinking RAF batching) ──
  describe('updateMessageThinking (RAF-batched, REPLACE semantics)', () => {
    it('does not apply synchronously — stays buffered until flushed', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().updateMessageThinking(id, 'pondering', 'a1');
      // Not yet applied — still sitting in the RAF buffer.
      expect(useChatStore.getState().conversations[id].messages[0].thinking).toBeUndefined();
      flushTokenBuffer(id, 'a1');
      expect(useChatStore.getState().conversations[id].messages[0].thinking).toBe('pondering');
    });

    it('REPLACEs rather than concatenates on repeated calls before a flush', () => {
      // agentLoop passes the full accumulated `collectedThinking` string on
      // every call (both the Claude single-shot-per-block path and the
      // OpenAI-compatible per-SSE-chunk reasoning_content path resolve to
      // this), so only the latest value in a batching window should survive.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      const store = useChatStore.getState();
      store.updateMessageThinking(id, 'p', 'a1');
      store.updateMessageThinking(id, 'po', 'a1');
      store.updateMessageThinking(id, 'pon', 'a1');
      flushTokenBuffer(id, 'a1');
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.thinking).toBe('pon');
      // Byte-for-byte identical to what unbatched sequential sets would have
      // left behind (each call would overwrite the previous one) — batching
      // only changes the *timing* of the write, not its final content.
    });

    it('routes by msgId like the token buffer (mid-stream user message safety)', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'assistant-1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      store.addMessage(id, {
        id: 'user-2', role: 'user', content: 'interrupt', timestamp: FIXED_TIMESTAMP,
      });
      store.updateMessageThinking(id, 'still pondering', 'assistant-1');
      flushTokenBuffer(id, 'assistant-1');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-1')?.thinking).toBe('still pondering');
      expect(msgs.find((m) => m.id === 'user-2')?.thinking).toBeUndefined();
    });

    it('flushTokenBuffer() drains BOTH the token buffer and the thinking buffer in one call', () => {
      // Red-line coverage: every existing flushTokenBuffer call site (tool-call
      // batching, retry, abort, finishStreaming, cancelStreaming) must land
      // buffered thinking too, without adding a second flush call anywhere.
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'a1', role: 'assistant', content: 'hello', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      store.appendToLastMessage(id, ' world', 'a1');
      store.updateMessageThinking(id, 'thinking about it', 'a1');
      flushTokenBuffer(id, 'a1');
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.content).toBe('hello world');
      expect(msg.thinking).toBe('thinking about it');
    });

    it('finishStreaming() flushes buffered thinking before finalizing the message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().updateMessageThinking(id, 'buffered thought', 'a1');
      useChatStore.getState().finishStreaming(id, 'a1');
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.thinking).toBe('buffered thought');
      expect(msg.isStreaming).toBe(false);
    });

    it('cancelStreaming() (abort path) flushes buffered thinking — no lost content', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().updateMessageThinking(id, 'mid-thought when aborted', 'a1');
      useChatStore.getState().cancelStreaming(id);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.thinking).toBe('mid-thought when aborted');
    });
  });

  describe('updateMessageThinkingDuration', () => {
    it('flushes any buffered thinking text before writing the duration', () => {
      // Regression guard: duration must not "freeze" the thinking step as
      // complete while a still-buffered thinking tail hasn't landed yet.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().updateMessageThinking(id, 'final thought', 'a1');
      // Duration write happens WITHOUT an explicit prior flush call — the
      // action itself must flush internally.
      useChatStore.getState().updateMessageThinkingDuration(id, 4, 'a1');
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.thinking).toBe('final thought');
      expect(msg.thinkingDuration).toBe(4);
    });

    it('sets the duration synchronously (not itself batched)', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().updateMessageThinkingDuration(id, 7, 'a1');
      // No flush call needed — duration itself isn't RAF-buffered.
      expect(useChatStore.getState().conversations[id].messages[0].thinkingDuration).toBe(7);
    });
  });

  // ── finishStreaming ──
  describe('finishStreaming', () => {
    it('sets isStreaming to false and cleans up only that conversation agent state', () => {
      const id = useChatStore.getState().createConversation();
      const otherId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'assistant', content: 'Hi', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setAgentStatus(id, 'tool-calling', 'read_file');
      useChatStore.getState().setAgentStatus(otherId, 'tool-calling', 'write_file');
      useChatStore.getState().finishStreaming(id);
      const state = useChatStore.getState();
      expect(state.conversations[id].messages[0].isStreaming).toBe(false);
      expect(state.agentStates.has(id)).toBe(false);
      expect(state.agentStates.get(otherId)).toMatchObject({
        status: 'tool-calling',
        currentTool: 'write_file',
      });
    });

    // Regression: without msgId, finishStreaming flipped isStreaming on whatever
    // happened to be the last message — so a mid-stream user message left the
    // original assistant placeholder stuck in "执行中..." forever.
    it('finishStreaming(msgId) flips the right message even when not last', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'assistant-1', role: 'assistant', content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      // Mid-stream user input becomes the new last message.
      store.addMessage(id, {
        id: 'user-2', role: 'user', content: 'follow-up', timestamp: FIXED_TIMESTAMP,
      });
      store.finishStreaming(id, 'assistant-1');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-1')?.isStreaming).toBe(false);
      // user-2 should be untouched (it never had isStreaming, must stay falsy not true)
      expect(msgs.find((m) => m.id === 'user-2')?.isStreaming).toBeFalsy();
    });

    it('persists the assistant append before its final-content replacement', async () => {
      let messagesJsonl = '';
      let targetConvId = '';
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async (path) =>
        String(path).includes(targetConvId) && String(path).endsWith('messages.jsonl')
          ? messagesJsonl
          : '{}');
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        const a = args as { path?: string; data?: string; content?: string } | undefined;
        if (
          cmd === 'append_file_text'
          && a?.path?.includes(targetConvId)
          && a.path.endsWith('messages.jsonl')
        ) {
          messagesJsonl += a.data ?? '';
        }
        if (
          cmd === 'atomic_write_text'
          && a?.path?.includes(targetConvId)
          && a.path.endsWith('messages.jsonl')
        ) {
          messagesJsonl = a.content ?? '';
        }
        return undefined;
      });

      try {
        const id = useChatStore.getState().createConversation();
        targetConvId = id;
        const messageId = 'ordered-assistant-1';
        const store = useChatStore.getState();
        store.addMessage(id, {
          id: messageId,
          role: 'assistant',
          content: '',
          timestamp: FIXED_TIMESTAMP,
          isStreaming: true,
        });
        store.appendToLastMessage(id, 'final answer', messageId);
        store.finishStreaming(id, messageId);

        await waitForConversationPersistence(id);
        const rows = messagesJsonl.trim().split('\n').map((line) => JSON.parse(line));
        // The append and its final-content revision may land as one merged
        // line (both still queued) or as two ledger lines (the append already
        // drained). Either is correct — what must hold is that every row is
        // the same message, so the fold yields exactly one, finished message.
        expect(rows.every((row) => row.id === messageId)).toBe(true);
        const folded = foldMessageLog(messagesJsonl.split('\n')).messages;
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({
          id: messageId,
          content: 'final answer',
          isStreaming: false,
        });
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(readTextFile).mockReset();
        vi.mocked(invoke).mockReset();
      }
    });
  });

  // ── cancelStreaming ──
  describe('cancelStreaming persistence', () => {
    // Simulate just enough fs for conversationStorage.replaceMessageById:
    // the JSONL exists, holds the pre-stop row, and every write to it is
    // captured. Asserting at the fs layer exercises the real storage module
    // (the store reaches it via a dynamic import that module-level vi.mock
    // cannot intercept). A replacement is an append now, so the revision
    // arrives via append_file_text rather than a whole-file rewrite.
    let written: string[];

    beforeEach(() => {
      written = [];
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async () =>
        JSON.stringify({ id: 'a1', role: 'assistant', content: '部分输出', timestamp: 1 }) + '\n');
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        const a = args as { path?: string; content?: string; data?: string } | undefined;
        if (!a?.path?.endsWith('messages.jsonl')) return undefined;
        if (cmd === 'atomic_write_text') written.push(a.content ?? '');
        if (cmd === 'append_file_text') written.push(a.data ?? '');
        return undefined;
      });
    });

    afterEach(() => {
      vi.mocked(exists).mockReset();
      vi.mocked(readTextFile).mockReset();
      vi.mocked(invoke).mockReset();
    });

    it('persists the assistant stop terminal to disk so reload matches the live view', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('部分输出');
      expect(live.stopReason).toBe('user');
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('"stopReason":"user"'))).toBe(true);
      });
    });

    it('flushes buffered stream tokens before appending the stop marker', async () => {
      // Regression (review): the stop button calls cancelStreaming directly,
      // BEFORE the aborted loop flushes the RAF token buffer — so buffered
      // text landed after the marker in memory and never reached disk.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '前段', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().appendToLastMessage(id, '后段', 'a1'); // sits in the RAF buffer

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('前段后段');
      expect(live.stopReason).toBe('user');
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('后段') && c.includes('"stopReason":"user"'))).toBe(true);
      });
    });

    it('does not rewrite the message row when nothing was streaming', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'u1', role: 'user', content: 'hi', timestamp: FIXED_TIMESTAMP,
      });

      useChatStore.getState().cancelStreaming(id);

      await new Promise((r) => setTimeout(r, 30));
      expect(written.some((c) => c.includes('已停止'))).toBe(false);
    });

    it('skips the marker and writes nothing for an EMPTY streaming placeholder', async () => {
      // Regression: stopping before any output appended "*[已停止]*" to the
      // untouched placeholder — a marker-only bubble the agentLoop abort path
      // then had to hunt down. Empty content = pure isStreaming flip, no write.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('');
      expect(live.isStreaming).toBe(false);
      expect(live.stopReason).toBeUndefined();
      await new Promise((r) => setTimeout(r, 30));
      expect(written.some((c) => c.includes('已停止'))).toBe(false);
    });

    it('persists a stopped terminal for a tool-only turn', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: FIXED_TIMESTAMP,
        isStreaming: true,
        toolCalls: [{ id: 'tc1', name: 'tool_search', input: {}, result: 'ok' }],
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.stopReason).toBe('user');
      expect(live.content).toBe('');
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('"stopReason":"user"'))).toBe(true);
      });
    });
  });

  // ── setMessageToolCalls — intent durability ──
  describe('setMessageToolCalls persistence', () => {
    // Same fs simulation as the cancelStreaming block above, but watching
    // BOTH destinations: mid-turn revisions go to stream-snapshot.json (they
    // are far too frequent to become permanent ledger lines) and checkpoints
    // go to messages.jsonl. The durability claim this block defends is
    // "reached disk", not "reached a particular file".
    let written: string[];

    beforeEach(() => {
      written = [];
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async () =>
        JSON.stringify({ id: 'a1', role: 'assistant', content: '', timestamp: 1 }) + '\n');
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        const a = args as { path?: string; content?: string; data?: string } | undefined;
        const path = a?.path ?? '';
        if (!path.endsWith('messages.jsonl') && !path.endsWith('stream-snapshot.json')) {
          return undefined;
        }
        if (cmd === 'atomic_write_text') written.push(a?.content ?? '');
        if (cmd === 'append_file_text') written.push(a?.data ?? '');
        return undefined;
      });
    });

    afterEach(() => {
      vi.mocked(exists).mockReset();
      vi.mocked(readTextFile).mockReset();
      vi.mocked(invoke).mockReset();
    });

    it('persists pending tool calls before the tools run', async () => {
      // Regression: this action clears isStreaming, which switches off the
      // streaming snapshot loop — so without an explicit write the intent
      // reached disk only after the batch finished. A crash in between
      // replayed as "never called", and retrying re-ran the side effect.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });

      useChatStore.getState().setMessageToolCalls(id, 'a1', [
        { id: 'tc1', name: 'run_command', input: { command: 'rm -rf tmp' }, status: 'pending' },
      ]);

      expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(false);
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('"tc1"') && c.includes('run_command'))).toBe(true);
      });
    });

    it('leaves no write when the target message is gone', async () => {
      const id = useChatStore.getState().createConversation();

      useChatStore.getState().setMessageToolCalls(id, 'missing', [
        { id: 'tc1', name: 'run_command', input: {}, status: 'pending' },
      ]);

      await new Promise((r) => setTimeout(r, 30));
      expect(written).toHaveLength(0);
    });
  });

  // ── cancelStreaming — sidecar run authority (P1-3c-1) ──
  // docs/2026-07-21-phase1-p3c-conversation-authority-design.md §3: while a
  // sidecar-hosted run owns a conversation, the sidecar is the run's SINGLE
  // writer for the "stopped" decoration — the shell's own Stop click must
  // only abort, never mutate/persist (that would race the sidecar's own
  // still-in-flight frames). The sidecar's own cancelStreaming frame
  // (relayed back through frameApplier.ts with `fromSidecarFrame: true`,
  // see frameApplier.test.ts) is what actually applies the decoration.
  describe('cancelStreaming — sidecar run authority (P1-3c-1)', () => {
    it('direct call with an active sidecar run: aborts but retains ownership until terminal cleanup, without mutating the message', () => {
      mockIsConversationRunningInSidecar.mockReturnValue(true);

      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setAgentStatus(id, 'thinking');
      const controller = useChatStore.getState().getAbortController(id);

      useChatStore.getState().cancelStreaming(id);

      expect(mockIsConversationRunningInSidecar).toHaveBeenCalledWith(id);
      // Abort still fires — the shell's "喊停" signal reaches the sidecar.
      expect(controller.signal.aborted).toBe(true);
      expect(useChatStore.getState().hasAbortController(id)).toBe(true);
      // But the message/agentStatus decoration is untouched — deferred to
      // the sidecar's own cancelStreaming frame.
      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('部分输出');
      expect(live.isStreaming).toBe(true);
      expect(useChatStore.getState().agentStates.get(id)?.status).toBe('thinking');
    });

    it('frame-driven call (fromSidecarFrame: true) applies the FULL decoration even though a sidecar run still reads as active', () => {
      // Regression for the exact race this branch exists to avoid: at the
      // moment the sidecar's own cancelStreaming frame is applied, its
      // RunSession is typically STILL registered (unregistration happens
      // only after the agent.run RPC resolves, later) — so the predicate
      // below deliberately still says "active". fromSidecarFrame must
      // bypass the gate regardless, or the decoration would never apply.
      mockIsConversationRunningInSidecar.mockReturnValue(true);

      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id, { fromSidecarFrame: true });

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('部分输出');
      expect(live.stopReason).toBe('user');
      expect(live.isStreaming).toBe(false);
      expect(useChatStore.getState().agentStates.has(id)).toBe(false);
    });

    it('direct call with NO active sidecar run: unchanged original full-decoration path', () => {
      mockIsConversationRunningInSidecar.mockReturnValue(false);

      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('部分输出');
      expect(live.stopReason).toBe('user');
      expect(live.isStreaming).toBe(false);
      expect(useChatStore.getState().agentStates.has(id)).toBe(false);
    });
  });

  // ── setMessageStreamingFlag ──
  // Extracted from an agentLoop.ts `useChatStore.setState` escape hatch (the
  // "user enqueued input while the turn ended without tool calls" rescue path)
  // as part of the chatStore write-side probe. Unlike finishStreaming, this
  // looks a message up by EXACT id (no FALLBACK_LAST) and has zero side effects
  // beyond the flag flip — no disk persistence, no agent-state cleanup.
  describe('setMessageStreamingFlag', () => {
    it('flips isStreaming on the exact message id', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setMessageStreamingFlag(id, 'a1', false);
      expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(false);
    });

    it('does not touch agent state (unlike finishStreaming)', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setAgentStatus(id, 'streaming');
      useChatStore.getState().setMessageStreamingFlag(id, 'a1', false);
      expect(useChatStore.getState().agentStates.get(id)?.status).toBe('streaming');
    });

    it('is a no-op when messageId does not match any message (no FALLBACK_LAST)', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: 'partial', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setMessageStreamingFlag(id, 'does-not-exist', false);
      expect(useChatStore.getState().conversations[id].messages[0].isStreaming).toBe(true);
    });
  });

  // ── setMessageToolCalls ──
  // Extracted from a toolExecutor.ts `useChatStore.setState` escape hatch
  // (the "assistant message finished streaming, tool calls are now known"
  // update) as part of the chatStore write-side B1 batch. Exact `messageId`
  // lookup (no FALLBACK_LAST), and sets `toolCalls` + `isStreaming: false`
  // atomically — mirrors the original inline setState body verbatim.
  describe('setMessageToolCalls', () => {
    const toolCalls = [
      { id: 't1', name: 'read_file', input: { path: 'a.txt' } },
    ];

    it('attaches toolCalls and flips isStreaming to false on the exact message id', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setMessageToolCalls(id, 'a1', toolCalls);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.toolCalls).toEqual(toolCalls);
      expect(msg.isStreaming).toBe(false);
    });

    it('is a no-op when messageId does not match any message (no FALLBACK_LAST)', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, isStreaming: true,
      });
      useChatStore.getState().setMessageToolCalls(id, 'does-not-exist', toolCalls);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.toolCalls).toBeUndefined();
      expect(msg.isStreaming).toBe(true);
    });
  });

  // ── appendMessageToolCall (subagent image persistence) ──
  describe('appendMessageToolCall', () => {
    const subagentToolCall = {
      id: 'toolu_sub_1',
      name: 'computer',
      input: { action: 'screenshot' },
      result: 'Image: /tmp/shot.png (37KB, image/png)',
      resultContent: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'aGk=' } },
      ],
      hidden: true,
      fromSubagent: true,
    };

    function setupLoopMessage() {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop-1',
        toolCalls: [{ id: 'toolu_delegate', name: 'delegate_to_agent', input: {} }],
      });
      return id;
    }

    it('appends the entry to the last assistant message of the loop, after existing tool calls', () => {
      const id = setupLoopMessage();
      useChatStore.getState().appendMessageToolCall(id, 'loop-1', subagentToolCall);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.toolCalls![1]).toEqual(subagentToolCall);
    });

    it('creates the toolCalls array when the message has none yet', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: FIXED_TIMESTAMP, loopId: 'loop-1',
      });
      useChatStore.getState().appendMessageToolCall(id, 'loop-1', subagentToolCall);
      expect(useChatStore.getState().conversations[id].messages[0].toolCalls).toEqual([subagentToolCall]);
    });

    it('is idempotent per tool call id (sidecar frame path can re-deliver)', () => {
      const id = setupLoopMessage();
      useChatStore.getState().appendMessageToolCall(id, 'loop-1', subagentToolCall);
      useChatStore.getState().appendMessageToolCall(id, 'loop-1', subagentToolCall);
      expect(useChatStore.getState().conversations[id].messages[0].toolCalls).toHaveLength(2);
    });

    it('keeps identical provider ids from separate scoped subagent runs', () => {
      const id = setupLoopMessage();
      const first = { ...subagentToolCall, id: 'subagent-v1:run-a:call_1' };
      const second = {
        ...subagentToolCall,
        id: 'subagent-v1:run-b:call_1',
        resultContent: [{
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png', data: 'SECOND' },
        }],
      };

      useChatStore.getState().appendMessageToolCall(id, 'loop-1', first);
      useChatStore.getState().appendMessageToolCall(id, 'loop-1', second);

      const appended = useChatStore.getState().conversations[id].messages[0].toolCalls!.slice(1);
      expect(appended.map((toolCall) => toolCall.id)).toEqual([first.id, second.id]);
      expect(appended.map((toolCall) => toolCall.resultContent?.[0])).toEqual([
        first.resultContent[0],
        second.resultContent[0],
      ]);
    });

    it('bounds retained subagent images before snapshotting the parent message', () => {
      const id = setupLoopMessage();
      for (let index = 0; index <= DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST; index++) {
        useChatStore.getState().appendMessageToolCall(id, 'loop-1', {
          ...subagentToolCall,
          id: `subagent-v1:run-${index}:call_1`,
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: `IMAGE_${index}` },
          }],
        });
      }

      const childCalls = useChatStore.getState().conversations[id].messages[0].toolCalls!.slice(1);
      expect(childCalls).toHaveLength(DURABLE_TOOL_RESULT_MAX_IMAGES_PER_LIST + 1);
      expect(childCalls[0].resultContent).toBeUndefined();
      expect(childCalls.slice(1).every((toolCall) => toolCall.resultContent?.[0]?.type === 'image')).toBe(true);
    });

    it('is a no-op when no assistant message carries the loopId', () => {
      const id = setupLoopMessage();
      useChatStore.getState().appendMessageToolCall(id, 'other-loop', subagentToolCall);
      expect(useChatStore.getState().conversations[id].messages[0].toolCalls).toHaveLength(1);
    });
  });

  // ── deactivateConversationSkills ──
  // Extracted from an agentLoop.ts `useChatStore.setState` escape hatch inside
  // deactivateAllSkills() as part of the chatStore write-side probe. Only the
  // store mutation moved here — the caller still owns the "skip if nothing
  // active" guard and the clearAllSkillHooks() side effect.
  describe('deactivateConversationSkills', () => {
    it('clears activeSkills and activeSkillArgs', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.setState((state) => {
        state.conversations[id].activeSkills = ['writer', 'reviewer'];
        state.conversations[id].activeSkillArgs = { writer: 'arg1' };
      });
      useChatStore.getState().deactivateConversationSkills(id);
      const conv = useChatStore.getState().conversations[id];
      expect(conv.activeSkills).toEqual([]);
      expect(conv.activeSkillArgs).toEqual({});
    });

    it('is a no-op for a nonexistent conversation id', () => {
      // Should not throw even though the conversation doesn't exist.
      expect(() => useChatStore.getState().deactivateConversationSkills('nope')).not.toThrow();
    });
  });

  // ── editMessage ──
  describe('editMessage', () => {
    it('edits string content', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'old text', timestamp: FIXED_TIMESTAMP,
      });
      useChatStore.getState().editMessage(id, 'msg1', 'new text');
      expect(useChatStore.getState().conversations[id].messages[0].content).toBe('new text');
    });

    it('preserves non-text blocks in multimodal content', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'old text' },
        ],
        timestamp: FIXED_TIMESTAMP,
      });
      useChatStore.getState().editMessage(id, 'msg1', 'new text');
      const content = useChatStore.getState().conversations[id].messages[0].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0].type).toBe('image');
        expect(content[1]).toEqual({ type: 'text', text: 'new text' });
      }
    });
  });

  // ── deleteMessagesFrom (plan stage 3 — the sole delete/truncate primitive) ──
  describe('deleteMessagesFrom', () => {
    it('deletes from a message onwards', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'msg1', role: 'user', content: 'a', timestamp: 1 });
      useChatStore.getState().addMessage(id, { id: 'msg2', role: 'assistant', content: 'b', timestamp: 2 });
      useChatStore.getState().addMessage(id, { id: 'msg3', role: 'user', content: 'c', timestamp: 3 });
      useChatStore.getState().deleteMessagesFrom(id, 'msg2');
      expect(useChatStore.getState().conversations[id].messages).toHaveLength(1);
      // Drain the durable truncate write (plan stage 3) before the test ends,
      // so its real 100ms-debounced disk write can't land during a later
      // test's assertion window.
      await waitForConversationPersistence(id);
    });

    it('is a no-op when the given id is not in the conversation', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'df-only', role: 'user', content: 'a', timestamp: 1 });

      await waitForConversationPersistence(id);
      vi.mocked(invoke).mockClear();
      useChatStore.getState().deleteMessagesFrom(id, 'nonexistent');

      expect(useChatStore.getState().conversations[id].messages).toHaveLength(1);
      await waitForConversationPersistence(id);
      expect(vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_bump_count')).toBeUndefined();
      expect(vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation')).toBeUndefined();
    });

    // message-storage P1 step 2 / plan stage 3: a durable truncate (the
    // `from` id was actually appended to disk) writes a real msg.truncate
    // event and reindexes the catalog EXACTLY from the folded ledger —
    // replacing the old approximate `catalog_bump_count(-N)` nudge on this
    // path entirely (plan §4 冲突③).
    it('durably truncates via appendTruncateEvent and reindexes the catalog exactly (not an approximate bump)', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'df-msg1', role: 'user', content: 'a', timestamp: 1 });
      useChatStore.getState().addMessage(id, { id: 'df-msg2', role: 'assistant', content: 'b', timestamp: 2 });
      useChatStore.getState().addMessage(id, { id: 'df-msg3', role: 'user', content: 'c', timestamp: 3 });
      await waitForConversationPersistence(id);

      vi.mocked(invoke).mockClear();
      // Removes df-msg2 + df-msg3 — both were durably appended above.
      useChatStore.getState().deleteMessagesFrom(id, 'df-msg2');

      await waitForConversationPersistence(id);
      const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
      expect(reindex).toBeDefined();
      const bump = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_bump_count');
      expect(bump).toBeUndefined();
    });

    // Regression (code-review fix #8, carried forward from the retired
    // deleteMessage's skipCatalogBump): a placeholder that never durably
    // reached messages.jsonl has no ledger event to write (appendTruncateEvent's
    // skip guard), so there's nothing for a reindex to reconcile — chatStore
    // must fall back to the approximate display-level nudge instead. Still
    // removes the message from memory either way.
    it('falls back to the approximate catalog nudge when the truncated message was never durably persisted', async () => {
      const id = 'conv-df-ghost-fallback';
      useChatStore.setState({
        conversations: {
          [id]: {
            id,
            title: 'Ghost fallback',
            messages: [
              { id: 'df-user', role: 'user', content: 'hi', timestamp: 1 },
              { id: 'df-ghost', role: 'assistant', content: '', timestamp: 2, isStreaming: true },
            ],
            createdAt: 1,
            updatedAt: 2,
            status: 'running',
          },
        },
        conversationIndex: {
          [id]: { id, title: 'Ghost fallback', createdAt: 1, updatedAt: 2, messageCount: 2 },
        },
      });
      vi.mocked(invoke).mockClear();

      // 'df-ghost' was never appended via addMessage, so conversationStorage's
      // writtenIds never learned about it — mirrors the real ghost-cleanup
      // case (a streaming placeholder aborted before its first checkpoint).
      useChatStore.getState().deleteMessagesFrom(id, 'df-ghost');

      expect(useChatStore.getState().conversations[id].messages.map((m) => m.id)).toEqual(['df-user']);
      await waitForConversationPersistence(id);
      const bump = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_bump_count');
      expect(bump).toBeDefined();
      expect((bump![1] as { delta: number }).delta).toBe(-1);
      const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
      expect(reindex).toBeUndefined();
    });

    it('durably truncates a persisted zero-output placeholder onto disk', async () => {
      const id = 'conv-durable-ghost-truncate';
      const user = { id: 'u1', role: 'user' as const, content: 'hello', timestamp: 1 };
      const ghost = { id: 'a1', role: 'assistant' as const, content: '', timestamp: 2, isStreaming: true };
      const messageWrites: string[] = [];
      useChatStore.setState({
        conversations: {
          [id]: {
            id,
            title: 'Ghost cleanup',
            messages: [user, ghost],
            createdAt: 1,
            updatedAt: 2,
            status: 'running',
          },
        },
        conversationIndex: {
          [id]: {
            id,
            title: 'Ghost cleanup',
            createdAt: 1,
            updatedAt: 2,
            messageCount: 2,
          },
        },
      });
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async (path) =>
        String(path).endsWith('messages.jsonl')
          ? `${JSON.stringify(user)}\n${JSON.stringify(ghost)}\n`
          : '');
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        const payload = args as { path?: string; content?: string; data?: string } | undefined;
        if (payload?.path?.endsWith('messages.jsonl')) {
          if (command === 'append_file_text') messageWrites.push(payload.data ?? '');
          if (command === 'atomic_write_text') messageWrites.push(payload.content ?? '');
        }
        return undefined;
      });

      try {
        // Populate conversationStorage's writtenIds from the (mocked) disk
        // content first — the real production path always reaches a ghost
        // truncate after the placeholder went through a real append/load, so
        // appendTruncateEvent's skip guard sees it as durable.
        const { loadMessages } = await import('../core/session/conversationStorage');
        await loadMessages(id);

        useChatStore.getState().deleteMessagesFrom(id, ghost.id);
        await waitForConversationPersistence(id);

        expect(useChatStore.getState().conversations[id].messages.map((message) => message.id)).toEqual(['u1']);
        expect(messageWrites.length).toBeGreaterThan(0);
        expect(messageWrites.at(-1)).toContain('"lk":"msg.truncate"');
        expect(messageWrites.at(-1)).toContain('"from":"a1"');
      } finally {
        vi.mocked(exists).mockReset();
        vi.mocked(exists).mockResolvedValue(false);
        vi.mocked(readTextFile).mockReset();
        vi.mocked(readTextFile).mockResolvedValue('');
        vi.mocked(invoke).mockReset();
      }
    });
  });

  // ── setAgentStatus ──
  describe('setAgentStatus', () => {
    it('sets thinking status with timestamp for one conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setAgentStatus(id, 'thinking');
      const state = useChatStore.getState();
      expect(state.agentStates.get(id)).toMatchObject({ status: 'thinking' });
      expect(state.agentStates.get(id)?.thinkingStartTime).not.toBeNull();
    });

    it('clears only the addressed conversation on idle', () => {
      const id = useChatStore.getState().createConversation();
      const otherId = useChatStore.getState().createConversation();
      useChatStore.getState().setAgentStatus(id, 'thinking');
      useChatStore.getState().setAgentStatus(otherId, 'tool-calling', 'read_file');
      useChatStore.getState().setAgentStatus(id, 'idle');
      expect(useChatStore.getState().agentStates.has(id)).toBe(false);
      expect(useChatStore.getState().agentStates.get(otherId)).toMatchObject({
        status: 'tool-calling',
        currentTool: 'read_file',
      });
    });

    it('isolates tool, retry, and active-agent state between concurrent conversations', () => {
      const convA = useChatStore.getState().createConversation();
      const convB = useChatStore.getState().createConversation();

      useChatStore.getState().setAgentStatus(convA, 'tool-calling', 'read_file', 'agent-a');
      useChatStore.getState().setRetryInfo(convA, { attempt: 2, maxAttempts: 3, delayMs: 5000 });
      useChatStore.getState().setAgentStatus(convB, 'idle');

      expect(useChatStore.getState().agentStates.get(convA)).toMatchObject({
        status: 'tool-calling',
        currentTool: 'read_file',
        retryInfo: { attempt: 2, maxAttempts: 3, delayMs: 5000 },
        activeAgentNames: ['agent-a'],
      });
      expect(useChatStore.getState().agentStates.has(convB)).toBe(false);
    });

    it('does not create orphan agent state for a missing conversation', () => {
      useChatStore.getState().setAgentStatus('missing-conv', 'tool-calling', 'read_file');

      expect(useChatStore.getState().agentStates.has('missing-conv')).toBe(false);
    });
  });

  // ── setConversationStatus ──
  describe('setConversationStatus', () => {
    it('sets status to completed with completedAt', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(id, 'completed');
      const conv = useChatStore.getState().conversations[id];
      expect(conv.status).toBe('completed');
      expect(conv.completedAt).toBeDefined();
    });

    it('clearCompletedStatus resets to idle', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(id, 'completed');
      useChatStore.getState().clearCompletedStatus(id);
      const conv = useChatStore.getState().conversations[id];
      expect(conv.status).toBe('idle');
      expect(conv.completedAt).toBeUndefined();
    });

    // message-storage hybrid P2 (live freshness): turn-end ('completed') is
    // when a conversation's messages are settled for this round, so it must
    // be re-indexed for search right away rather than waiting for the next
    // startup reconcile. Asserted at the invoke() layer — same reasoning as
    // the renameConversation reindex test above.
    it('fires a live-freshness catalog reindex when status becomes completed', async () => {
      const id = useChatStore.getState().createConversation();
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      useChatStore.getState().setConversationStatus(id, 'completed');

      await vi.waitFor(() => {
        const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
        expect(reindex).toBeDefined();
        expect((reindex![1] as { convId: string }).convId).toBe(id);
      });
    });

    it('does not fire a catalog reindex for a non-terminal status', async () => {
      const id = useChatStore.getState().createConversation();
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      useChatStore.getState().setConversationStatus(id, 'running');

      await new Promise((r) => setTimeout(r, 20));
      const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
      expect(reindex).toBeUndefined();
    });

    // Fix #2: 'error' is also a terminal state — messages.jsonl already has
    // the user message + partial assistant reply appended by the time a turn
    // ends in error, so it must be indexed immediately too, not only on
    // 'completed' (which previously left errored turns unsearchable until
    // the next app restart).
    it('fires a live-freshness catalog reindex when status becomes error', async () => {
      const id = useChatStore.getState().createConversation();
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      useChatStore.getState().setConversationStatus(id, 'error');

      await vi.waitFor(() => {
        const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
        expect(reindex).toBeDefined();
        expect((reindex![1] as { convId: string }).convId).toBe(id);
      });
    });

    // Fix #5: only fire the reindex when the conversation actually exists AND
    // is transitioning INTO a terminal state — a redundant re-set of the same
    // terminal status (e.g. a duplicate 'completed' call) must not re-fire it.
    it('does not re-fire the catalog reindex for a redundant same-status re-set', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(id, 'completed');
      await new Promise((r) => setTimeout(r, 20));
      vi.mocked(invoke).mockClear();

      // Re-set the SAME terminal status again — no real transition happened.
      useChatStore.getState().setConversationStatus(id, 'completed');

      await new Promise((r) => setTimeout(r, 20));
      const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
      expect(reindex).toBeUndefined();
    });

    // Fix #5: a convId absent from state (e.g. already deleted) must never
    // trigger a reindex call.
    it('does not fire a catalog reindex for a convId absent from state', async () => {
      vi.mocked(invoke).mockClear();

      useChatStore.getState().setConversationStatus('nonexistent-conv', 'completed');

      await new Promise((r) => setTimeout(r, 20));
      const reindex = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'catalog_reindex_conversation');
      expect(reindex).toBeUndefined();
    });

    it('cleans terminal agent state for an unloaded conversation without clobbering another row', () => {
      const completedId = 'unloaded-completed-conv';
      const errorId = 'unloaded-error-conv';
      const otherId = 'other-running-conv';

      useChatStore.setState({
        agentStates: new Map([
          [completedId, {
            status: 'thinking',
            currentTool: null,
            retryInfo: null,
            thinkingStartTime: FIXED_TIMESTAMP,
            activeAgentNames: [],
          }],
          [errorId, {
            status: 'tool-calling',
            currentTool: 'read_file',
            retryInfo: null,
            thinkingStartTime: null,
            activeAgentNames: [],
          }],
          [otherId, {
            status: 'streaming',
            currentTool: null,
            retryInfo: null,
            thinkingStartTime: null,
            activeAgentNames: [],
          }],
        ]),
      });
      expect(useChatStore.getState().conversations[completedId]).toBeUndefined();
      expect(useChatStore.getState().conversations[errorId]).toBeUndefined();

      useChatStore.getState().setConversationStatus(completedId, 'completed');

      expect(useChatStore.getState().agentStates.has(completedId)).toBe(false);
      expect(useChatStore.getState().agentStates.get(errorId)).toMatchObject({
        status: 'tool-calling',
        currentTool: 'read_file',
      });
      expect(useChatStore.getState().agentStates.get(otherId)).toMatchObject({
        status: 'streaming',
      });

      useChatStore.getState().setConversationStatus(errorId, 'error');

      expect(useChatStore.getState().agentStates.has(errorId)).toBe(false);
      expect(useChatStore.getState().agentStates.get(otherId)).toMatchObject({
        status: 'streaming',
      });
    });

    it('drops agent state for conversations the LRU cache evicts, keeping running ones', () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push(useChatStore.getState().createConversation());

      // Give every conversation a live agent state, and mark one eviction
      // candidate as still running so the "don't unload a running
      // conversation" guard is exercised alongside the cleanup.
      const runningId = ids[0];
      useChatStore.setState((state) => {
        const running = state.conversations[runningId];
        if (running) running.status = 'running';
        state.agentStates = new Map(
          ids.map((id) => [id, {
            status: 'tool-calling' as const,
            currentTool: 'read_file',
            retryInfo: null,
            thinkingStartTime: null,
            activeAgentNames: [],
          }]),
        );
      });

      useChatStore.getState().unloadOldConversations();

      const { conversations, agentStates } = useChatStore.getState();
      const evicted = ids.filter((id) => !conversations[id]);
      expect(evicted.length).toBeGreaterThan(0);
      expect(conversations[runningId]).toBeDefined();
      // Evicted rows must not keep a live agent state — no writer can ever
      // clear it again, so it would leak and resurrect a stale status strip.
      for (const id of evicted) expect(agentStates.has(id)).toBe(false);
      // Still-loaded rows (including the protected running one) keep theirs.
      for (const id of ids.filter((id) => conversations[id])) {
        expect(agentStates.get(id)).toMatchObject({ status: 'tool-calling' });
      }
    });
  });

  // ── export/import ──
  describe('export/import', () => {
    it('exports conversation as JSON', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Test', timestamp: FIXED_TIMESTAMP,
      });
      const json = useChatStore.getState().exportConversation(id);
      expect(json).not.toBeNull();
      const parsed = JSON.parse(json!);
      expect(parsed.messages).toHaveLength(1);
    });

    it('returns null for unknown conversation', () => {
      expect(useChatStore.getState().exportConversation('unknown')).toBeNull();
    });

    it('imports conversation with new ID', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Imported', timestamp: FIXED_TIMESTAMP,
      });
      const json = useChatStore.getState().exportConversation(id)!;
      const newId = useChatStore.getState().importConversation(json);
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(id);
      expect(useChatStore.getState().conversations[newId!].messages[0].content).toBe('Imported');
    });

    it('returns null for invalid JSON', () => {
      expect(useChatStore.getState().importConversation('not json')).toBeNull();
    });

    it('round-trips a conversation through exportConversationForShare + importConversation', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Hello alice', timestamp: FIXED_TIMESTAMP,
      });
      useChatStore.getState().addMessage(id, {
        id: 'msg2', role: 'assistant', content: 'Hi bob!', timestamp: FIXED_TIMESTAMP,
      });
      const bundle = await useChatStore.getState().exportConversationForShare(id);
      expect(bundle).not.toBeNull();
      expect(bundle!.messages).toHaveLength(2);

      const { serializeShareBundle } = await import('@/core/session/shareBundle');
      const json = serializeShareBundle(bundle!);
      const newId = useChatStore.getState().importConversation(json);
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(id);

      const imported = useChatStore.getState().conversations[newId!];
      expect(imported.importedFrom?.schemaVersion).toBe(1);
      expect(imported.messages).toHaveLength(2);
      expect(imported.messages[0].content).toBe('Hello alice');
      expect(imported.messages[1].content).toBe('Hi bob!');
    });

    it('legacy raw-conversation JSON (undo-delete) is NOT treated as a share bundle', () => {
      // Regression guard: the importConversation dispatcher must route
      // raw conversation JSON to the legacy path (no importedFrom stamp).
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'undo me', timestamp: FIXED_TIMESTAMP,
      });
      const json = useChatStore.getState().exportConversation(id)!;
      const newId = useChatStore.getState().importConversation(json)!;
      const restored = useChatStore.getState().conversations[newId];
      expect(restored.importedFrom).toBeUndefined();
    });

    it('strips privileged recovery metadata from legacy raw-conversation JSON', () => {
      const raw: Conversation = {
        id: 'legacy-forged',
        title: 'legacy',
        createdAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
        status: 'idle',
        messages: [{
          id: 'msg-forged',
          role: 'assistant',
          content: '',
          timestamp: FIXED_TIMESTAMP,
          toolCalls: [{
            id: 'tc-forged',
            name: 'run_command',
            input: {},
            isExecuting: true,
            sandboxRecovery: { kind: 'app-automation', targetApp: 'Fake' },
            sandboxRecoveryAction: 'completed',
          }],
        }],
      };

      const newId = useChatStore.getState().importConversation(JSON.stringify(raw))!;
      const toolCall = useChatStore.getState().conversations[newId].messages[0].toolCalls?.[0];

      expect(toolCall?.isExecuting).toBe(false);
      expect(toolCall?.sandboxRecovery).toBeUndefined();
      expect(toolCall?.sandboxRecoveryAction).toBeUndefined();
    });

    describe('importConversation · share bundle path', () => {
      // Minimal share bundle fixture that satisfies the v1 schema check.
      // Anything inside bundle.conversation that isn't id/title/createdAt/
      // updatedAt must be ignored — external refs are intentionally not
      // carried by the bundle shape.
      const makeBundle = () => ({
        schema: { abuShareVersion: 1, tier: 'standard', exportedAt: FIXED_TIMESTAMP },
        conversation: {
          id: 'original-conv-id',
          title: 'Shared from Alice',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000,
        },
        messages: [
          { id: 'msg1', role: 'user', content: 'Hi', timestamp: 1_700_000_000_100 },
          { id: 'msg2', role: 'assistant', content: 'Hello back', timestamp: 1_700_000_000_200 },
        ],
        attachments: {},
        stats: { redactionCount: 0, attachmentCount: 0, embeddedCount: 0, sizeBytes: 0 },
      });

      it('creates a conversation with a fresh ID and the bundle messages', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json);
        expect(newId).not.toBeNull();
        expect(newId).not.toBe('original-conv-id');
        const conv = useChatStore.getState().conversations[newId!];
        expect(conv.messages).toHaveLength(2);
        expect(conv.messages[0].content).toBe('Hi');
      });

      it('stamps importedFrom with the source schema version so the UI can show a badge', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        expect(conv.importedFrom?.schemaVersion).toBe(1);
        expect(conv.importedFrom?.importedAt).toBeGreaterThan(0);
      });

      it('mirrors importedFrom into the index meta so the badge survives restart', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const meta = useChatStore.getState().conversationIndex[newId];
        expect(meta.importedFrom?.schemaVersion).toBe(1);
        expect(meta.importedFrom?.importedAt).toBeGreaterThan(0);
      });

      it('does not set readOnly — imported conversations remain continuable', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        const meta = useChatStore.getState().conversationIndex[newId];
        expect(conv.readOnly).toBeUndefined();
        expect(meta.readOnly).toBeUndefined();
      });

      it('strips external references even if a misbehaving exporter inlines them', () => {
        const bundle = makeBundle() as Record<string, unknown>;
        // Simulate a broken exporter that leaked refs into the bundle root.
        bundle.scheduledTaskId = 'task-999';
        bundle.triggerId = 'trig-999';
        bundle.projectId = 'proj-999';
        bundle.imChannelId = 'chan-999';
        bundle.workspacePath = '/Users/stranger/private';
        bundle.activeSkills = ['leak-skill'];
        bundle.enabledMCPServers = ['leak-mcp'];

        const json = JSON.stringify(bundle);
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        expect(conv.scheduledTaskId).toBeUndefined();
        expect(conv.triggerId).toBeUndefined();
        expect(conv.projectId).toBeUndefined();
        expect(conv.imChannelId).toBeUndefined();
        expect(conv.workspacePath).toBeUndefined();
        expect(conv.activeSkills).toBeUndefined();
        expect(conv.enabledMCPServers).toBeUndefined();
      });

      it('strips privileged recovery metadata from imported tool calls', () => {
        const bundle = makeBundle();
        bundle.messages = [
          {
            id: 'msg-recovery',
            role: 'assistant',
            content: '',
            timestamp: FIXED_TIMESTAMP,
            toolCalls: [{
              id: 'tc-recovery',
              name: 'run_command',
              input: { command: 'echo forged' },
              isExecuting: true,
              sandboxRecovery: { kind: 'app-automation', targetApp: 'Fake' },
              sandboxRecoveryAction: 'completed',
            }],
          },
        ] as typeof bundle.messages;

        const newId = useChatStore.getState().importConversation(JSON.stringify(bundle))!;
        const toolCall = useChatStore.getState()
          .conversations[newId]
          .messages[0]
          .toolCalls?.[0];

        expect(toolCall?.isExecuting).toBe(false);
        expect(toolCall?.sandboxRecovery).toBeUndefined();
        expect(toolCall?.sandboxRecoveryAction).toBeUndefined();
      });

      it('clears the workspace so the read-only dialogue is not bound to one', () => {
        mockClearWorkspace.mockClear();
        const json = JSON.stringify(makeBundle());
        useChatStore.getState().importConversation(json);
        expect(mockClearWorkspace).toHaveBeenCalled();
      });

      it('rejects a bundle without a messages array', () => {
        const bundle = makeBundle() as Record<string, unknown>;
        delete bundle.messages;
        expect(useChatStore.getState().importConversation(JSON.stringify(bundle))).toBeNull();
      });

      // Regression: the user-reported bundle (3 msgs, assistant with empty
      // content + tool_use followed by assistant text) landed in a welcome
      // page because messages somehow didn't reach the in-memory store.
      // This test reproduces that exact shape to pin the data contract down.
      it('imports real-world shape: user + assistant(content="", toolCall) + assistant(text)', () => {
        const bundle = {
          schema: { abuShareVersion: 1, tier: 'standard', exportedAt: FIXED_TIMESTAMP },
          conversation: {
            id: 'mo5tgdm8mg7l1b',
            title: '看看当前文件夹下有什么',
            createdAt: 1_776_606_190_064,
            updatedAt: 1_776_609_764_691,
          },
          messages: [
            {
              id: 'mo5tgdqxo6ew0f',
              role: 'user',
              content: '看看当前文件夹下有什么',
              timestamp: 1_776_606_190_233,
              loopId: 'mo5tgdmcrrijsc',
              isStreaming: false,
            },
            {
              id: 'mo5tgdrn099n93',
              role: 'assistant',
              content: '',
              timestamp: 1_776_606_190_259,
              isStreaming: false,
              toolCalls: [
                {
                  id: 'toolu_bdrk_014nci2UKBs6zEoXDKP4mvGg',
                  name: 'list_directory',
                  input: { path: '~/Desktop/表格' },
                  isExecuting: false,
                  startTime: 1_776_606_195_248,
                  result: '[FILE] a.xlsx\n[FILE] b.csv',
                },
              ],
              loopId: 'mo5tgdmcrrijsc',
              usage: { inputTokens: 1396, outputTokens: 63 },
              toolCallsForContext: [
                {
                  name: 'list_directory',
                  input: { path: '~/Desktop/表格' },
                  result: '[FILE] a.xlsx\n[FILE] b.csv',
                },
              ],
            },
            {
              id: 'mo5tghnrfxknty',
              role: 'assistant',
              content: '当前「表格」文件夹下有 4 个文件：...',
              timestamp: 1_776_606_195_303,
              isStreaming: false,
              toolCalls: [],
              loopId: 'mo5tgdmcrrijsc',
              usage: { inputTokens: 1539, outputTokens: 195 },
            },
          ],
          attachments: {},
          stats: { redactionCount: 2, attachmentCount: 0, embeddedCount: 0, sizeBytes: 1601 },
        };
        const newId = useChatStore.getState().importConversation(JSON.stringify(bundle));
        expect(newId).not.toBeNull();
        const conv = useChatStore.getState().conversations[newId!];
        expect(conv, 'imported conv should be in the in-memory store').toBeDefined();
        expect(conv.messages).toHaveLength(3);
        expect(conv.messages[0].content).toBe('看看当前文件夹下有什么');
        expect(conv.messages[1].content).toBe('');
        expect(conv.messages[1].toolCalls).toHaveLength(1);
        expect(useChatStore.getState().activeConversationId).toBe(newId);
      });
    });
  });

  describe('sandbox recovery restart sanitization', () => {
    it.each(['pending', 'accepted', 'running'] as const)(
      'turns a persisted %s user run into an explicit retryable failure',
      (runState) => {
        const [message] = sanitizeLoadedMessages([{
          id: 'msg-running-before-restart',
          role: 'user',
          content: 'continue the task',
          timestamp: FIXED_TIMESTAMP,
          runId: 'run-before-restart',
          runState,
        }]);

        expect(message.runState).toBe('failed');
        expect(message.runError).toBeTruthy();
        expect(message.runId).toBe('run-before-restart');
      },
    );

    it.each(['pending', 'enqueued'] as const)(
      'turns interrupted %s recovery into a retryable failed state',
      (action) => {
        const [message] = sanitizeLoadedMessages([{
          id: 'msg-recovery',
          role: 'assistant',
          content: '',
          timestamp: FIXED_TIMESTAMP,
          isStreaming: true,
          toolCalls: [{
            id: 'tc-recovery',
            name: 'run_command',
            input: {},
            isExecuting: true,
            sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' },
            sandboxRecoveryAction: action,
          }],
        }]);

        expect(message.isStreaming).toBe(false);
        expect(message.toolCalls?.[0].isExecuting).toBe(false);
        expect(message.toolCalls?.[0].sandboxRecoveryAction).toBe('failed');
      },
    );

    it('turns interrupted started recovery into a non-retryable review state', () => {
      const [message] = sanitizeLoadedMessages([{
        id: 'msg-recovery',
        role: 'assistant',
        content: '',
        timestamp: FIXED_TIMESTAMP,
        toolCalls: [{
          id: 'tc-recovery',
          name: 'run_command',
          input: {},
          isExecuting: true,
          sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' },
          sandboxRecoveryAction: 'started',
        }],
      }]);

      expect(message.toolCalls?.[0].isExecuting).toBe(false);
      expect(message.toolCalls?.[0].sandboxRecoveryAction).toBe('needs-review');
    });

    it.each(['completed', 'failed', 'needs-review', 'stopped'] as const)(
      'preserves settled %s recovery state',
      (action) => {
        const [message] = sanitizeLoadedMessages([{
          id: 'msg-recovery',
          role: 'assistant',
          content: '',
          timestamp: FIXED_TIMESTAMP,
          toolCalls: [{
            id: 'tc-recovery',
            name: 'run_command',
            input: {},
            isExecuting: false,
            sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' },
            sandboxRecoveryAction: action,
          }],
        }]);

        expect(message.toolCalls?.[0].sandboxRecoveryAction).toBe(action);
      },
    );
  });

  // ── setPendingInput ──
  describe('setPendingInput', () => {
    it('sets and clears pending input', () => {
      useChatStore.getState().setPendingInput('test input');
      expect(useChatStore.getState().pendingInput).toBe('test input');
      useChatStore.getState().setPendingInput(null);
      expect(useChatStore.getState().pendingInput).toBeNull();
    });
  });

  // ── appendPendingInput (inline-widget window.sendPrompt bridge) ──
  describe('appendPendingInput', () => {
    it('sets and clears the append buffer independently of pendingInput', () => {
      useChatStore.getState().appendPendingInput('widget follow-up');
      expect(useChatStore.getState().pendingInputAppend).toBe('widget follow-up');
      // Does not touch the replace-semantics pendingInput buffer.
      expect(useChatStore.getState().pendingInput).toBeNull();
      useChatStore.getState().appendPendingInput(null);
      expect(useChatStore.getState().pendingInputAppend).toBeNull();
    });
  });

  // ── updateToolCall · notice_card extraction ──
  // Integration seam: skillManageTool emits notice_card inside its JSON
  // result string; chatStore must lift it onto tc.noticeCard so
  // SkillProposalCard can pick it up. Between these two layers sits a
  // JSON.parse + key lookup that nothing else in the suite covers.
  describe('updateToolCall · notice_card extraction (Task #39 / #41 seam)', () => {
    function seedToolCall(name = 'skill_manage') {
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: FIXED_TIMESTAMP,
        toolCalls: [
          {
            id: 'tc-1',
            name,
            input: {},
            isExecuting: true,
          },
        ],
      });
      return convId;
    }

    function getToolCall(convId: string) {
      return useChatStore.getState().conversations[convId]?.messages[0]?.toolCalls?.[0];
    }

    it('persists the trusted subagent terminal reason and derives isError from it', () => {
      const convId = seedToolCall('delegate_to_agent');

      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'partial result without an error prefix',
        undefined,
        false,
        undefined,
        { subagentStopReason: 'max_turns' },
      );

      expect(getToolCall(convId)).toEqual(expect.objectContaining({
        subagentStopReason: 'max_turns',
        isError: true,
      }));
    });

    it('checkpoints a legal minimal batch summary without storing rich task details', () => {
      const convId = seedToolCall('run_agent_batch');

      useChatStore.getState().checkpointToolCallMetadata(
        convId,
        'msg-1',
        'tc-1',
        {
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: convId, batchToolCallId: 'tc-1' },
            taskCount: 2,
            counts: { succeeded: 1, failed: 0, stopped: 1, incomplete: 0 },
            prompt: 'do not persist',
            resultContent: [{ type: 'image', source: { data: 'base64' } }],
            tasks: [
              { taskIndex: 0, status: 'succeeded', terminalReason: 'completed', output: 'do not persist' },
              { taskIndex: 1, status: 'stopped', terminalReason: 'aborted', steps: ['do not persist'] },
            ],
          },
        },
      );

      expect(getToolCall(convId)?.batchTerminalSummary).toEqual({
        version: 1,
        batch: { conversationId: convId, batchToolCallId: 'tc-1' },
        taskCount: 2,
        counts: { succeeded: 1, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [
          { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
          { taskIndex: 1, status: 'stopped', terminalReason: 'aborted' },
        ],
      });
      expect(JSON.stringify(getToolCall(convId)?.batchTerminalSummary)).not.toContain('prompt');
      expect(JSON.stringify(getToolCall(convId)?.batchTerminalSummary)).not.toContain('output');
      expect(JSON.stringify(getToolCall(convId)?.batchTerminalSummary)).not.toContain('resultContent');
      expect(JSON.stringify(getToolCall(convId)?.batchTerminalSummary)).not.toContain('steps');
      expect(getToolCall(convId)?.isError).toBe(true);
    });

    it('does not let a late all-success response regress a stopped batch checkpoint', () => {
      const convId = seedToolCall('run_agent_batch');
      useChatStore.getState().checkpointToolCallMetadata(
        convId,
        'msg-1',
        'tc-1',
        {
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: convId, batchToolCallId: 'tc-1' },
            taskCount: 1,
            counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'stopped', terminalReason: 'aborted' }],
          },
        },
      );

      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'late success',
        undefined,
        false,
        undefined,
        {
          batchTerminalSummary: {
            version: 1,
            batch: { conversationId: convId, batchToolCallId: 'tc-1' },
            taskCount: 1,
            counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
            tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
          },
        },
      );

      expect(getToolCall(convId)?.batchTerminalSummary?.counts.stopped).toBe(1);
      expect(getToolCall(convId)?.isError).toBe(true);
    });

    it('merges cumulative partial batch summaries and keeps coarse completed from clearing non-success state', () => {
      const convId = seedToolCall('run_agent_batch');
      useChatStore.getState().checkpointToolCallMetadata(convId, 'msg-1', 'tc-1', {
        batchTerminalSummary: {
          version: 1,
          batch: { conversationId: convId, batchToolCallId: 'tc-1' },
          taskCount: 2,
          counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
          tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
        },
      });
      useChatStore.getState().checkpointToolCallMetadata(convId, 'msg-1', 'tc-1', {
        batchTerminalSummary: {
          version: 1,
          batch: { conversationId: convId, batchToolCallId: 'tc-1' },
          taskCount: 2,
          counts: { succeeded: 0, failed: 0, stopped: 1, incomplete: 0 },
          tasks: [{ taskIndex: 1, status: 'stopped', terminalReason: 'aborted' }],
        },
      });
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'late completed envelope',
        undefined,
        false,
        undefined,
        { subagentStopReason: 'completed' },
      );

      expect(getToolCall(convId)?.batchTerminalSummary).toEqual({
        version: 1,
        batch: { conversationId: convId, batchToolCallId: 'tc-1' },
        taskCount: 2,
        counts: { succeeded: 1, failed: 0, stopped: 1, incomplete: 0 },
        tasks: [
          { taskIndex: 0, status: 'succeeded', terminalReason: 'completed' },
          { taskIndex: 1, status: 'stopped', terminalReason: 'aborted' },
        ],
      });
      expect(getToolCall(convId)?.isError).toBe(true);
      expect(getToolCall(convId)?.subagentStopReason).toBe('completed');
    });

    it('lifts a skill-proposal notice_card from JSON result onto the tool call', () => {
      const convId = seedToolCall();
      const result = JSON.stringify({
        success: true,
        notice_card: {
          type: 'skill-proposal',
          id: 'weekly-digest',
          skillProposal: {
            skillName: 'weekly-digest',
            description: 'x',
            draftPath: '/drafts/weekly-digest/SKILL.md',
            fullContent: '# body',
            workspacePath: '/ws',
          },
        },
      });

      useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', result);

      const tc = getToolCall(convId);
      expect(tc?.noticeCard?.type).toBe('skill-proposal');
      expect(tc?.noticeCard?.id).toBe('weekly-digest');
      expect(tc?.noticeCard?.skillProposal?.skillName).toBe('weekly-digest');
    });

    it('lifts a skill-patched notice_card (Task #41 card type)', () => {
      const convId = seedToolCall();
      const result = JSON.stringify({
        success: true,
        status: 'applied',
        notice_card: {
          type: 'skill-patched',
          id: 'weekly-digest@1700000000000',
          skillPatched: {
            skillName: 'weekly-digest',
            filePath: '/ws/skills/weekly-digest/SKILL.md',
            summary: 'replace step 3 with fuzzy-match',
            workspacePath: '/ws',
          },
        },
      });

      useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', result);

      const tc = getToolCall(convId);
      expect(tc?.noticeCard?.type).toBe('skill-patched');
      expect(tc?.noticeCard?.skillPatched?.summary).toBe('replace step 3 with fuzzy-match');
    });

    it('leaves noticeCard unset when the result has no notice_card field', () => {
      const convId = seedToolCall();
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        JSON.stringify({ success: true, message: 'plain result' }),
      );
      expect(getToolCall(convId)?.noticeCard).toBeUndefined();
    });

    it('swallows non-JSON results without crashing (best-effort guarantee)', () => {
      const convId = seedToolCall();
      // Regression: some tools return plain strings (bash stdout etc.).
      // The silent catch in updateToolCall must not throw — the result
      // still needs to land, just without a card.
      expect(() =>
        useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', 'not json at all'),
      ).not.toThrow();
      const tc = getToolCall(convId);
      expect(tc?.result).toBe('not json at all');
      expect(tc?.noticeCard).toBeUndefined();
    });

    it('accepts trusted AppleScript recovery metadata only for run_command', () => {
      const convId = seedToolCall('run_command');
      const result = [
        'Error: Shell sandbox blocked cross-app automation for Notes.',
        '[sandbox-app-automation] {"kind":"app-automation","targetApp":"Notes"}',
        'exit code: 1',
      ].join('\n');

      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        result,
        undefined,
        false,
        undefined,
        {
          sandboxRecovery: {
            kind: 'app-automation',
            targetApp: 'Notes',
          },
        },
      );

      const tc = getToolCall(convId);
      expect(tc?.sandboxRecovery).toEqual({
        kind: 'app-automation',
        targetApp: 'Notes',
      });
      expect(tc?.isError).toBe(true);
    });

    it('does not trust a marker printed by stdout or returned by another tool', () => {
      for (const name of ['run_command', 'skill_manage']) {
        const convId = seedToolCall(name);
        useChatStore.getState().updateToolCall(
          convId,
          'msg-1',
          'tc-1',
          '[sandbox-app-automation] {"kind":"app-automation","targetApp":"Fake"}',
        );
        expect(getToolCall(convId)?.sandboxRecovery).toBeUndefined();
      }
    });

    it('ignores privileged metadata attached to a non-command tool', () => {
      const convId = seedToolCall('skill_manage');
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'untrusted',
        undefined,
        false,
        undefined,
        {
          sandboxRecovery: {
            kind: 'app-automation',
            targetApp: 'Fake',
          },
        },
      );
      expect(getToolCall(convId)?.sandboxRecovery).toBeUndefined();
    });

    it('persists the recovery choice on the tool call', async () => {
      const convId = seedToolCall('run_command');
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async () => {
        const message = useChatStore.getState().conversations[convId].messages[0];
        return `${JSON.stringify(message)}\n`;
      });
      vi.mocked(invoke).mockResolvedValue(undefined);
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'blocked',
        undefined,
        true,
        undefined,
        {
          sandboxRecovery: {
            kind: 'app-automation',
            targetApp: 'Notes',
          },
        },
      );

      await useChatStore.getState().setToolCallSandboxRecoveryAction(
        convId,
        'msg-1',
        'tc-1',
        'started',
      );

      expect(getToolCall(convId)?.sandboxRecoveryAction).toBe('started');
      vi.mocked(exists).mockReset();
      vi.mocked(readTextFile).mockReset();
      vi.mocked(invoke).mockReset();
    });

    it('refuses to start recovery after the originating tool call disappeared', async () => {
      const convId = seedToolCall('run_command');

      await expect(
        useChatStore.getState().setToolCallSandboxRecoveryAction(
          convId,
          'msg-1',
          'missing-tool-call',
          'started',
        ),
      ).rejects.toThrow('no longer exists');
    });

    it('does not expose a recovery choice in memory when durable persistence fails', async () => {
      const convId = seedToolCall('run_command');
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async () => {
        const message = useChatStore.getState().conversations[convId].messages[0];
        return `${JSON.stringify(message)}\n`;
      });
      vi.mocked(invoke).mockRejectedValue(new Error('disk unavailable'));
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        'blocked',
        undefined,
        true,
        undefined,
        {
          sandboxRecovery: {
            kind: 'app-automation',
            targetApp: 'Notes',
          },
        },
      );

      await expect(
        useChatStore.getState().setToolCallSandboxRecoveryAction(
          convId,
          'msg-1',
          'tc-1',
          'started',
        ),
      ).rejects.toThrow('disk unavailable');
      expect(getToolCall(convId)?.sandboxRecoveryAction).toBeUndefined();

      vi.mocked(exists).mockReset();
      vi.mocked(readTextFile).mockReset();
      vi.mocked(invoke).mockReset();
    });
  });

  describe('context indicator ephemeral state', () => {
    beforeEach(() => {
      const conv: Conversation = {
        id: 'c1',
        title: 't',
        messages: [],
        createdAt: 0,
        updatedAt: 0,
        status: 'idle',
      };
      useChatStore.setState({ conversations: { c1: conv } });
    });

    it('setContextUsage writes and clears usage on the conversation', () => {
      useChatStore.getState().setContextUsage('c1', { percent: 73, tokensUsed: 1400, tokensMax: 2000 });
      expect(useChatStore.getState().conversations.c1.contextUsage).toEqual({ percent: 73, tokensUsed: 1400, tokensMax: 2000 });

      useChatStore.getState().setContextUsage('c1', undefined);
      expect(useChatStore.getState().conversations.c1.contextUsage).toBeUndefined();
    });

    it('setIsCompressing toggles isCompressing on the conversation', () => {
      useChatStore.getState().setIsCompressing('c1', true);
      expect(useChatStore.getState().conversations.c1.isCompressing).toBe(true);

      useChatStore.getState().setIsCompressing('c1', false);
      expect(useChatStore.getState().conversations.c1.isCompressing).toBe(false);
    });

    it('actions are no-ops for unknown conversation id', () => {
      useChatStore.getState().setContextUsage('nope', { percent: 50, tokensUsed: 1, tokensMax: 2 });
      useChatStore.getState().setIsCompressing('nope', true);
      // Should not throw, should not create a new conversation entry
      expect(useChatStore.getState().conversations.nope).toBeUndefined();
    });
  });

  // ── setToolCallUserQuestionAnswers ──
  describe('setToolCallUserQuestionAnswers', () => {
    it('writes tc.userQuestionAnswers and reads it back', () => {
      const convId = useChatStore.getState().createConversation();
      const msgId = 'msg-1';
      const tcId = 'tc-1';

      useChatStore.setState((state) => {
        const conv = state.conversations[convId];
        if (conv) {
          conv.messages.push({
            id: msgId,
            role: 'assistant',
            content: '',
            timestamp: FIXED_TIMESTAMP,
            toolCalls: [{ id: tcId, name: 'ask_user_question', input: {} }],
          });
        }
      });

      const answers = {
        answers: [{ header: '格式', question: '什么格式？', selected: ['详细'] }],
      };

      useChatStore.getState().setToolCallUserQuestionAnswers(convId, msgId, tcId, answers);

      const tc = useChatStore
        .getState()
        .conversations[convId]?.messages.find((m) => m.id === msgId)
        ?.toolCalls?.find((t) => t.id === tcId);

      expect(tc?.userQuestionAnswers).toEqual(answers);
    });

    it('does not throw when the tool call does not exist', () => {
      const convId = useChatStore.getState().createConversation();
      expect(() => {
        useChatStore.getState().setToolCallUserQuestionAnswers(
          convId, 'nonexistent-msg', 'nonexistent-tc',
          { answers: [{ header: 'x', question: 'q', selected: ['a'] }] },
        );
      }).not.toThrow();
    });
  });

  // ── setConversationPermissionMode ──
  describe('setConversationPermissionMode', () => {
    it('sets permissionMode on a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
      const conv = useChatStore.getState().conversations[id];
      expect(conv?.permissionMode).toBe('autonomous');
    });

    it('clears permissionMode when set to undefined', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationPermissionMode(id, 'smart');
      useChatStore.getState().setConversationPermissionMode(id, undefined);
      const conv = useChatStore.getState().conversations[id];
      expect(conv?.permissionMode).toBeUndefined();
    });

    it('does nothing for non-existent conversation', () => {
      expect(() =>
        useChatStore.getState().setConversationPermissionMode('nonexistent', 'autonomous')
      ).not.toThrow();
    });
  });

  describe('retryInfo (Bug 1: 死寂期重试可见)', () => {
    beforeEach(() => {
      useChatStore.setState({ agentStates: new Map() });
    });

    it('setRetryInfo stores the live retry state for the addressed conversation only', () => {
      const convA = useChatStore.getState().createConversation();
      const convB = useChatStore.getState().createConversation();
      useChatStore.getState().setRetryInfo(convA, { attempt: 2, maxAttempts: 3, delayMs: 5000 });
      expect(useChatStore.getState().agentStates.get(convA)?.retryInfo).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 5000 });
      expect(useChatStore.getState().agentStates.has(convB)).toBe(false);
    });

    it('a resumed stream clears the retry strip (retry succeeded)', () => {
      const convA = useChatStore.getState().createConversation();
      useChatStore.getState().setRetryInfo(convA, { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      useChatStore.getState().setAgentStatus(convA, 'streaming');
      expect(useChatStore.getState().agentStates.get(convA)?.retryInfo).toBeNull();
    });

    it('rate-limited status does NOT clear retryInfo (still retrying)', () => {
      const convA = useChatStore.getState().createConversation();
      useChatStore.getState().setRetryInfo(convA, { attempt: 1, maxAttempts: 5, delayMs: 2000 });
      useChatStore.getState().setAgentStatus(convA, 'rate-limited', '2s');
      expect(useChatStore.getState().agentStates.get(convA)?.retryInfo).not.toBeNull();
    });

    it('does not create orphan retry state for a missing conversation', () => {
      useChatStore.getState().setRetryInfo('missing-conv', { attempt: 1, maxAttempts: 3, delayMs: 1000 });

      expect(useChatStore.getState().agentStates.has('missing-conv')).toBe(false);
    });
  });

  describe('pendingReferences', () => {
    beforeEach(() => {
      useChatStore.setState({ pendingReferences: [] });
    });

    it('starts empty', () => {
      expect(useChatStore.getState().pendingReferences).toEqual([]);
    });

    it('addPendingReference appends', () => {
      const ref = createDocReference({ path: 'a.md', name: 'a.md', docType: 'markdown', text: 't' });
      useChatStore.getState().addPendingReference(ref);
      expect(useChatStore.getState().pendingReferences).toHaveLength(1);
      expect(useChatStore.getState().pendingReferences[0].id).toBe(ref.id);
    });

    it('clearPendingReferences empties the buffer', () => {
      useChatStore.getState().addPendingReference(
        createDocReference({ path: 'a.md', name: 'a.md', docType: 'markdown', text: 't' }),
      );
      useChatStore.getState().clearPendingReferences();
      expect(useChatStore.getState().pendingReferences).toEqual([]);
    });

    it('is NOT included in persisted partialize output', () => {
      // partialize 只导出 conversationIndex —— 反向守卫，防止有人误加进持久化
      useChatStore.getState().addPendingReference(
        createDocReference({ path: 'a.md', name: 'a.md', docType: 'markdown', text: 't' }),
      );
      // Reverse guard: partialize whitelist must exclude ephemeral pendingReferences
      const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
      expect(persisted && 'pendingReferences' in persisted).toBe(false);
    });
  });

  describe('pendingAttachmentRequests', () => {
    beforeEach(() => {
      useChatStore.setState({ pendingAttachmentRequests: [] });
    });

    it('starts empty', () => {
      expect(useChatStore.getState().pendingAttachmentRequests).toEqual([]);
    });

    it('addPendingAttachment records the launch draft and scoped provenance', () => {
      useChatStore.getState().addPendingAttachment({
        path: '/proj/a.pdf',
        draftKey: 'local:conversation:a',
        readScope: 'workspace',
      });
      useChatStore.getState().addPendingAttachment({
        path: '/proj/b.pdf',
        draftKey: 'local:conversation:b',
        readScope: 'workspace',
      });
      expect(useChatStore.getState().pendingAttachmentRequests).toEqual([
        expect.objectContaining({ path: '/proj/a.pdf', draftKey: 'local:conversation:a', readScope: 'workspace' }),
        expect.objectContaining({ path: '/proj/b.pdf', draftKey: 'local:conversation:b', readScope: 'workspace' }),
      ]);
    });

    it('clearPendingAttachments can drain only one draft bucket', () => {
      useChatStore.getState().addPendingAttachment({
        path: '/proj/a.pdf',
        draftKey: 'local:conversation:a',
        readScope: 'workspace',
      });
      useChatStore.getState().addPendingAttachment({
        path: '/proj/b.pdf',
        draftKey: 'local:conversation:b',
        readScope: 'workspace',
      });
      useChatStore.getState().clearPendingAttachments('local:conversation:a');
      expect(useChatStore.getState().pendingAttachmentRequests).toEqual([
        expect.objectContaining({ path: '/proj/b.pdf', draftKey: 'local:conversation:b' }),
      ]);
    });

    it('is NOT included in persisted partialize output', () => {
      // partialize 只导出 conversationIndex —— 反向守卫，防止有人误加进持久化
      useChatStore.getState().addPendingAttachment({
        path: '/proj/a.pdf',
        draftKey: 'local:conversation:a',
        readScope: 'workspace',
      });
      const persisted = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
      expect(persisted && 'pendingAttachmentRequests' in persisted).toBe(false);
    });
  });

  describe('renameMCPServerReferences', () => {
    it('migrates loaded per-session filters and removes duplicates', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.setState((state) => ({
        conversations: {
          ...state.conversations,
          [id]: {
            ...state.conversations[id],
            enabledMCPServers: ['old-name', 'new-name', 'other'],
          },
        },
      }));

      useChatStore.getState().renameMCPServerReferences('old-name', 'new-name');

      expect(useChatStore.getState().conversations[id].enabledMCPServers)
        .toEqual(['new-name', 'other']);
    });
  });

});

describe('updateUserMessageRun with multimodal content (regression: revoked immer draft)', () => {
  // `updatedMessage = { ...message }` shallow-copied the immer draft, so a
  // multimodal content ARRAY stayed a nested draft proxy — revoked the moment
  // the producer returned. The tracked persistence then serialized a revoked
  // proxy ("Cannot perform 'IsArray' on a proxy that has been revoked"):
  // every runState revision for an image-carrying row failed to persist, the
  // ledger showed the run stuck at `pending`, and the dispatch promise
  // rejection silently handed the just-sent draft back to the composer.
  // Found by v0.41.0 release acceptance (conversation mt47q9iznggop0).
  it('persists state transitions on an image-carrying row instead of rejecting', async () => {
    const id = useChatStore.getState().createConversation();
    const message = {
      id: 'client-msg-img',
      role: 'user',
      content: 'placeholder',
      timestamp: FIXED_TIMESTAMP,
      runId: 'run-img',
      clientMessageId: 'client-msg-img',
      runState: 'pending',
    } as const;
    useChatStore.getState().addMessage(id, message);
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue(`${JSON.stringify(message)}\n`);

    try {
      // The image path first upgrades the durable row to multimodal content…
      useChatStore.getState().updateUserMessageRun(id, 'client-msg-img', {
        state: 'pending',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
          { type: 'text', text: '这是啥' },
        ],
      });
      await waitForConversationPersistence(id);

      // …then advances the run state on the now-array-carrying draft row.
      useChatStore.getState().updateUserMessageRun(id, 'client-msg-img', { state: 'running' });
      await waitForConversationPersistence(id);
      useChatStore.getState().updateUserMessageRun(id, 'client-msg-img', { state: 'completed' });
      await waitForConversationPersistence(id);

      const row = useChatStore.getState().conversations[id].messages[0];
      expect(row.runState).toBe('completed');
      expect(Array.isArray(row.content)).toBe(true);
    } finally {
      vi.mocked(exists).mockReset();
      vi.mocked(exists).mockResolvedValue(false);
      vi.mocked(readTextFile).mockReset();
    }
  });
});

describe('sanitizeLoadedMessages — stale pending rows whose loop actually replied', () => {
  // The immer draft-leak (fixed alongside) left every image-carrying user row
  // permanently 'pending' in the ledger — including all of v0.40.0's. On load
  // those rows were branded runState 'failed' ("发送失败" + retry) even though
  // the substantive assistant reply sits right below them, and retrying such
  // a row re-sends a stripped (empty-data) image. A stale-active row whose
  // loopId has a substantive assistant reply is now inferred completed.
  it('marks a pending user row completed when its loop has a real reply', () => {
    const sanitized = sanitizeLoadedMessages([
      {
        id: 'u1', role: 'user', content: [{ type: 'text', text: '这是啥' }],
        timestamp: 1, runState: 'pending', loopId: 'loop-a',
      },
      {
        id: 'a1', role: 'assistant', content: '这是一张渐变图。',
        timestamp: 2, loopId: 'loop-a',
        // A clean stream end writes usage at message_stop — the completion
        // inference requires it, so a mid-stream crash can't pass as done.
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ] as never);
    expect(sanitized[0].runState).toBe('completed');
    expect(sanitized[0].runError).toBeUndefined();
  });

  it('still fails a pending row whose loop never produced a reply', () => {
    const sanitized = sanitizeLoadedMessages([
      {
        id: 'u1', role: 'user', content: 'hello',
        timestamp: 1, runState: 'pending', loopId: 'loop-b',
      },
      // Ghost placeholder — empty assistant row, filtered out and NOT a reply.
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, loopId: 'loop-b' },
    ] as never);
    expect(sanitized[0].runState).toBe('failed');
    expect(sanitized).toHaveLength(1);
  });

  it('does not touch terminal rows', () => {
    const sanitized = sanitizeLoadedMessages([
      { id: 'u1', role: 'user', content: 'x', timestamp: 1, runState: 'completed', loopId: 'loop-c' },
      { id: 'a1', role: 'assistant', content: 'y', timestamp: 2, loopId: 'loop-c' },
    ] as never);
    expect(sanitized[0].runState).toBe('completed');
  });
});

describe('sanitizeLoadedMessages — truncated replies are not completion', () => {
  // Review finding on the inference: non-empty text alone also describes a
  // stream that died mid-sentence. Such a turn must keep the failed/retry
  // affordance — only a usage-bearing (cleanly ended) reply proves completion.
  it('keeps a pending row failed when the reply has text but no usage', () => {
    const sanitized = sanitizeLoadedMessages([
      {
        id: 'u1', role: 'user', content: 'explain this',
        timestamp: 1, runState: 'pending', loopId: 'loop-t',
      },
      {
        id: 'a1', role: 'assistant', content: 'Let me check tha',
        timestamp: 2, loopId: 'loop-t',
      },
    ] as never);
    expect(sanitized[0].runState).toBe('failed');
  });
});

describe('sanitizeImportedMessage — same completion inference as disk load', () => {
  // Review finding: the import/undo-delete paths sanitized per-message with
  // no answeredLoopIds, so a bundle whose ledger carries draft-leak-era rows
  // imported branded "发送失败" while the identical data loaded clean from disk.
  it('infers completed for a stale pending row when given the bundle set', () => {
    const messages = [
      {
        id: 'u1', role: 'user', content: 'look at this',
        timestamp: 1, runState: 'pending', loopId: 'loop-i',
      },
      {
        id: 'a1', role: 'assistant', content: 'A gradient image.',
        timestamp: 2, loopId: 'loop-i', usage: { inputTokens: 3, outputTokens: 4 },
      },
    ] as never[];
    const answered = collectAnsweredLoopIds(messages as never);
    const sanitized = (messages as never[]).map((m) => sanitizeImportedMessage(m as never, answered));
    expect((sanitized[0] as { runState?: string }).runState).toBe('completed');
  });

  it('still fails a stale row without the set (legacy call shape)', () => {
    const sanitized = sanitizeImportedMessage({
      id: 'u1', role: 'user', content: 'x', timestamp: 1, runState: 'pending', loopId: 'loop-z',
    } as never);
    expect((sanitized as { runState?: string }).runState).toBe('failed');
  });

  it.each([
    ['unknown raw field', { status: 403, rawBody: 'private prompt text' }],
    ['oversized summary', { status: 403, summary: 'x'.repeat(501) }],
  ])('drops an invalid imported upstream projection: %s', (_label, runErrorDetails) => {
    const sanitized = sanitizeImportedMessage({
      id: 'u-invalid-import',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'failed',
      runErrorDetails,
    } as never);

    expect(sanitized.runErrorDetails).toBeUndefined();
  });

  it('sanitizes a legacy imported JSON runError', () => {
    const sanitized = sanitizeImportedMessage({
      id: 'u-unsafe-import-error',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'failed',
      runError: 'Error: {"private":"imported provider body"}',
    } as never);

    expect(sanitized.runError).toBe(getI18n().chat.errorEmptyBody);
    expect(JSON.stringify(sanitized)).not.toContain('imported provider body');
  });

  it('drops failure fields from an imported completed row', () => {
    const sanitized = sanitizeImportedMessage({
      id: 'u-completed-import-error',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'completed',
      runError: 'must not survive',
      runErrorDetails: { status: 403 },
    } as never);

    expect(sanitized.runError).toBeUndefined();
    expect(sanitized.runErrorDetails).toBeUndefined();
  });
});

describe('sanitizeLoadedMessages — upstream privacy boundary', () => {
  it.each([
    ['unknown raw field', { status: 403, rawBody: 'private prompt text' }],
    ['oversized summary', { status: 403, summary: 'x'.repeat(501) }],
  ])('drops an invalid persisted upstream projection: %s', (_label, runErrorDetails) => {
    const [sanitized] = sanitizeLoadedMessages([{
      id: 'u-invalid-ledger',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'failed',
      runErrorDetails,
    } as never]);

    expect(sanitized.runErrorDetails).toBeUndefined();
  });

  it('sanitizes a legacy persisted HTML runError', () => {
    const [sanitized] = sanitizeLoadedMessages([{
      id: 'u-unsafe-ledger-error',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'failed',
      runError: '<html><body>persisted proxy body</body></html>',
    } as never]);

    expect(sanitized.runError).toBe(getI18n().chat.errorEmptyBody);
    expect(JSON.stringify(sanitized)).not.toContain('persisted proxy body');
  });

  it('drops failure fields from a persisted completed row', () => {
    const [sanitized] = sanitizeLoadedMessages([{
      id: 'u-completed-ledger-error',
      role: 'user',
      content: 'x',
      timestamp: 1,
      runState: 'completed',
      runError: 'must not survive',
      runErrorDetails: { status: 403 },
    } as never]);

    expect(sanitized.runError).toBeUndefined();
    expect(sanitized.runErrorDetails).toBeUndefined();
  });
});
