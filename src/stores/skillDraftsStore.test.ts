import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSkillDraftsStore, stopDraftsSweeper } from './skillDraftsStore';
import { useWorkspaceStore } from './workspaceStore';
import { useChatStore } from './chatStore';
import * as drafts from '../core/skill/drafts';
import type { DraftRecord } from '../core/skill/drafts';
import type { Conversation, ToolCall } from '../types';

// The store imports these stores at module init; they're real zustand so we
// just manipulate state via setState. Drafts module is mocked — we're testing
// store orchestration, not the filesystem layer (that's drafts.test.ts).
vi.mock('../core/skill/drafts', () => ({
  listDrafts: vi.fn().mockResolvedValue([]),
  acceptDraft: vi.fn().mockResolvedValue({ targetDir: '' }),
  rejectDraft: vi.fn().mockResolvedValue({ trashDir: '' }),
  cleanExpiredDrafts: vi.fn().mockResolvedValue(0),
  emptyExpiredTrash: vi.fn().mockResolvedValue(0),
}));

vi.mock('../core/skill/loader', () => ({
  skillLoader: {
    discoverSkills: vi.fn().mockResolvedValue([]),
  },
}));

// discoveryStore also reaches for skillLoader etc.; stub its refresh.
vi.mock('./discoveryStore', () => ({
  useDiscoveryStore: {
    getState: () => ({
      refresh: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

const mockListDrafts = vi.mocked(drafts.listDrafts);
const mockAcceptDraft = vi.mocked(drafts.acceptDraft);
const mockRejectDraft = vi.mocked(drafts.rejectDraft);
const mockCleanExpired = vi.mocked(drafts.cleanExpiredDrafts);
const mockEmptyTrash = vi.mocked(drafts.emptyExpiredTrash);

const WS = '/Users/testuser/projects/myapp';

function makeRecord(name: string, overrides: Partial<DraftRecord> = {}): DraftRecord {
  const now = Date.now();
  return {
    id: name,
    skillName: name,
    skillDir: `/drafts/${name}`,
    skillMdPath: `/drafts/${name}/SKILL.md`,
    action: 'create',
    triggerReason: '',
    createdAt: now,
    expiresAt: now + 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSkillDraftsStore.setState({
    drafts: [],
    isLoading: false,
    lastRefreshedAt: null,
    lastError: null,
  });
  useWorkspaceStore.setState({ currentPath: WS });
  stopDraftsSweeper();
});

describe('skillDraftsStore · refresh', () => {
  it('clears drafts when no workspace is active', async () => {
    useWorkspaceStore.setState({ currentPath: null });
    useSkillDraftsStore.setState({ drafts: [makeRecord('stale')] });
    // The workspace subscription in the store may have fired a refresh on
    // setup; we're only interested in the explicit refresh() below.
    mockListDrafts.mockClear();

    await useSkillDraftsStore.getState().refresh();
    expect(useSkillDraftsStore.getState().drafts).toEqual([]);
    expect(mockListDrafts).not.toHaveBeenCalled();
  });

  it('pulls the latest draft list from drafts.ts', async () => {
    mockListDrafts.mockResolvedValueOnce([makeRecord('a'), makeRecord('b')]);

    await useSkillDraftsStore.getState().refresh();

    const s = useSkillDraftsStore.getState();
    expect(s.drafts.map((d) => d.skillName)).toEqual(['a', 'b']);
    expect(s.isLoading).toBe(false);
    expect(s.lastRefreshedAt).toBeGreaterThan(0);
    expect(s.lastError).toBeNull();
  });

  it('surfaces errors via lastError without throwing', async () => {
    mockListDrafts.mockRejectedValueOnce(new Error('permission denied'));

    await useSkillDraftsStore.getState().refresh();

    expect(useSkillDraftsStore.getState().lastError).toBe('permission denied');
    expect(useSkillDraftsStore.getState().isLoading).toBe(false);
  });
});

describe('skillDraftsStore · acceptDraft', () => {
  it('moves the draft and re-refreshes', async () => {
    mockListDrafts.mockResolvedValueOnce([]); // after-accept refresh returns empty

    const result = await useSkillDraftsStore.getState().acceptDraft('daily-report');

    expect(result).toEqual({ ok: true });
    expect(mockAcceptDraft).toHaveBeenCalledWith('daily-report', WS);
    expect(mockListDrafts).toHaveBeenCalled(); // refresh was triggered
  });

  it('returns ok:false when no workspace', async () => {
    useWorkspaceStore.setState({ currentPath: null });
    const result = await useSkillDraftsStore.getState().acceptDraft('x');
    expect(result.ok).toBe(false);
    expect(mockAcceptDraft).not.toHaveBeenCalled();
  });

  it('workspaceOverride succeeds when global store is null', async () => {
    // Regression guard for "card click after restart / conv switch":
    // notice cards carry their original workspace, so accept must honor
    // it even when useWorkspaceStore has been cleared.
    useWorkspaceStore.setState({ currentPath: null });
    mockListDrafts.mockClear();

    const result = await useSkillDraftsStore.getState().acceptDraft('from-card', '/captured/ws');

    expect(result).toEqual({ ok: true });
    expect(mockAcceptDraft).toHaveBeenCalledWith('from-card', '/captured/ws');
  });

  it('acceptDraft syncs global workspaceStore to the override', async () => {
    // Regression guard for "accepted skill invisible in Toolbox":
    // discoveryStore.refresh reads the live global workspace. If accept
    // leaves the global at null while writing the skill under the override
    // workspace, the skill never appears in the main list.
    useWorkspaceStore.setState({ currentPath: null });

    await useSkillDraftsStore.getState().acceptDraft('any', '/captured/ws');

    expect(useWorkspaceStore.getState().currentPath).toBe('/captured/ws');
  });

  it('captures filesystem errors without crashing', async () => {
    mockAcceptDraft.mockRejectedValueOnce(new Error('already exists'));

    const result = await useSkillDraftsStore.getState().acceptDraft('dup');

    expect(result).toEqual({ ok: false, error: 'already exists' });
    expect(useSkillDraftsStore.getState().lastError).toBe('already exists');
  });
});

describe('skillDraftsStore · rejectDraft', () => {
  it('delegates to drafts.rejectDraft and refreshes', async () => {
    const result = await useSkillDraftsStore.getState().rejectDraft('bad', 'not useful');

    expect(result).toEqual({ ok: true });
    expect(mockRejectDraft).toHaveBeenCalledWith('bad', WS, 'not useful');
    expect(mockListDrafts).toHaveBeenCalled();
  });

  it('returns ok:false when no workspace', async () => {
    useWorkspaceStore.setState({ currentPath: null });
    const result = await useSkillDraftsStore.getState().rejectDraft('x');
    expect(result.ok).toBe(false);
  });

  it('accepts new options object form with workspaceOverride', async () => {
    // Regression guard: SkillProposalCard now calls rejectDraft with
    // `{ category: true, workspaceOverride }` so the store settles peer
    // cards with the correct tone. Legacy string form still works.
    useWorkspaceStore.setState({ currentPath: null });

    const result = await useSkillDraftsStore.getState().rejectDraft('x', {
      category: true,
      workspaceOverride: '/captured/ws',
    });

    expect(result).toEqual({ ok: true });
    expect(mockRejectDraft).toHaveBeenCalledWith('x', '/captured/ws', undefined);
  });
});

// ── Card ↔ Panel sync (Task #39) ────────────────────────────────────
// After accept/reject FS operations complete, any matching
// skill-proposal cards in chat history must flip to settled state so
// the user sees consistent UX whether they clicked in the panel or
// in the in-chat card. Uses real chatStore state + setState.
describe('skillDraftsStore · card sync', () => {
  const CONV_ID = 'conv-1';
  const MSG_ID = 'msg-1';
  const TC_ID = 'tc-1';

  function seedCard(skillName: string, overrides: Partial<ToolCall> = {}) {
    const tc: ToolCall = {
      id: TC_ID,
      name: 'skill_manage',
      input: {},
      noticeCard: {
        type: 'skill-proposal',
        id: skillName,
      },
      ...overrides,
    };
    const conv: Conversation = {
      id: CONV_ID,
      title: 'test',
      messages: [
        {
          id: MSG_ID,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [tc],
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
    };
    useChatStore.setState({ conversations: { [CONV_ID]: conv } });
  }

  function getToolCall() {
    return useChatStore.getState().conversations[CONV_ID]?.messages[0]?.toolCalls?.[0];
  }

  it('accepted draft flips matching chat cards to settled=accepted', async () => {
    seedCard('weekly-digest');

    await useSkillDraftsStore.getState().acceptDraft('weekly-digest');

    expect(getToolCall()?.noticeCardAction).toBe('accepted');
  });

  it('rejectDraft (plain) flips matching cards to settled=rejected', async () => {
    seedCard('weekly-digest');

    await useSkillDraftsStore.getState().rejectDraft('weekly-digest');

    expect(getToolCall()?.noticeCardAction).toBe('rejected');
  });

  it('rejectDraft with category:true flips cards to settled=rejected-category', async () => {
    seedCard('weekly-digest');

    await useSkillDraftsStore
      .getState()
      .rejectDraft('weekly-digest', { category: true });

    expect(getToolCall()?.noticeCardAction).toBe('rejected-category');
  });

  it('does not overwrite cards the user already settled', async () => {
    // Prior accept/reject click on the card should win even if a later
    // panel-side action fires — preserves the original user trace.
    seedCard('weekly-digest', { noticeCardAction: 'rejected-category' });

    await useSkillDraftsStore.getState().acceptDraft('weekly-digest');

    expect(getToolCall()?.noticeCardAction).toBe('rejected-category');
  });

  it('ignores cards with a different skill name', async () => {
    seedCard('other-skill');

    await useSkillDraftsStore.getState().acceptDraft('weekly-digest');

    // Untouched — skill name mismatch.
    expect(getToolCall()?.noticeCardAction).toBeUndefined();
  });
});

describe('skillDraftsStore · cleanExpired / cleanTrash', () => {
  it('refreshes when cleanExpired actually swept something', async () => {
    mockCleanExpired.mockResolvedValueOnce(3);

    const n = await useSkillDraftsStore.getState().cleanExpired();

    expect(n).toBe(3);
    expect(mockListDrafts).toHaveBeenCalled();
  });

  it('skips refresh when cleanExpired found nothing', async () => {
    mockCleanExpired.mockResolvedValueOnce(0);

    const n = await useSkillDraftsStore.getState().cleanExpired();

    expect(n).toBe(0);
    expect(mockListDrafts).not.toHaveBeenCalled();
  });

  it('cleanTrash returns swept count without refreshing (trash isn’t in state)', async () => {
    mockEmptyTrash.mockResolvedValueOnce(2);
    const n = await useSkillDraftsStore.getState().cleanTrash();
    expect(n).toBe(2);
    expect(mockListDrafts).not.toHaveBeenCalled();
  });

  it('both cleanup actions return 0 when no workspace', async () => {
    useWorkspaceStore.setState({ currentPath: null });
    expect(await useSkillDraftsStore.getState().cleanExpired()).toBe(0);
    expect(await useSkillDraftsStore.getState().cleanTrash()).toBe(0);
  });
});
