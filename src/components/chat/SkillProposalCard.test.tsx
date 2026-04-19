/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillProposalCard from './SkillProposalCard';
import type { InteractiveNoticeCard } from '@/types';

// ── Mocks ───────────────────────────────────────────────────────────────
// All the stores the component calls into. Mocking at module level
// (not via useXxx.setState) because SkillProposalCard reads selector
// functions directly via `useXxxStore((s) => s.action)` — those selectors
// need the module to expose stable references or the test can't assert
// which action ran.

const mockAcceptDraft = vi.fn();
const mockRejectDraft = vi.fn();
const mockSetAction = vi.fn();
const mockAddToast = vi.fn();
const mockOpenToolbox = vi.fn();
const mockSetToolboxSearchQuery = vi.fn();
const mockWriteMemory = vi.fn().mockResolvedValue('memo.md');

// Drafts store state is controlled per-test via this mutable object.
// Defaults mimic "draft is live, store has initialized" so existing
// accept/reject/active tests still see buttons.
const draftsStoreState: {
  drafts: { skillName: string }[];
  isLoading: boolean;
  lastRefreshedAt: number | null;
  acceptDraft: typeof mockAcceptDraft;
  rejectDraft: typeof mockRejectDraft;
} = {
  drafts: [{ skillName: 'weekly-digest' }],
  isLoading: false,
  lastRefreshedAt: Date.now(),
  acceptDraft: mockAcceptDraft,
  rejectDraft: mockRejectDraft,
};

vi.mock('@/stores/skillDraftsStore', () => ({
  useSkillDraftsStore: (selector: (s: unknown) => unknown) => selector(draftsStoreState),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ setToolCallNoticeCardAction: mockSetAction }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (s: unknown) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

// Mutable per-test settings state so tests can toggle the Task #50
// onboarding gate on/off. Default: onboarding done (mimics steady-
// state users) so the existing accept/reject/defer tests keep working
// without needing to mock around the gate.
const settingsState = {
  soul: { draftsOnboardingShown: true, proactivity: 'companion' as const },
  openToolbox: mockOpenToolbox,
  setToolboxSearchQuery: mockSetToolboxSearchQuery,
};

vi.mock('@/stores/settingsStore', () => {
  const useSettingsStore = ((selector: (s: typeof settingsState) => unknown) =>
    selector(settingsState)) as {
    (selector: (s: typeof settingsState) => unknown): unknown;
    getState: () => typeof settingsState;
  };
  useSettingsStore.getState = () => settingsState;
  return { useSettingsStore };
});

vi.mock('@/core/memdir/write', () => ({
  writeMemory: (...args: unknown[]) => mockWriteMemory(...args),
}));

// MarkdownRenderer is non-trivial — stub to a simple div so we can assert
// the expand-preview renders the full SKILL.md content without pulling in
// the whole markdown pipeline.
vi.mock('./MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}));

const SAMPLE_CARD: InteractiveNoticeCard = {
  type: 'skill-proposal',
  id: 'weekly-digest',
  skillProposal: {
    skillName: 'weekly-digest',
    description: 'Generate a weekly Jira digest',
    triggerReason: '8 tool calls succeeded',
    draftPath: '/abu/projects/ws/skills/drafts/weekly-digest/SKILL.md',
    fullContent: '# Weekly Digest\n\nSample body for preview',
    workspacePath: '/Users/test/myproj',
  },
};

function renderCard(overrides: { settledAction?: 'accepted' | 'rejected' | 'rejected-category' | 'deferred' } = {}) {
  return render(
    <SkillProposalCard
      conversationId="conv-1"
      messageId="msg-1"
      toolCallId="tc-1"
      card={SAMPLE_CARD}
      settledAction={overrides.settledAction}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAcceptDraft.mockReset().mockResolvedValue({ ok: true });
  mockRejectDraft.mockReset().mockResolvedValue({ ok: true });
  mockWriteMemory.mockReset().mockResolvedValue('memo.md');
  // Reset drafts state to "live draft, store initialized" baseline.
  draftsStoreState.drafts = [{ skillName: 'weekly-digest' }];
  draftsStoreState.isLoading = false;
  draftsStoreState.lastRefreshedAt = Date.now();
  // Reset onboarding to "done" baseline — the Task #50 gate tests flip
  // this to false locally.
  settingsState.soul.draftsOnboardingShown = true;
});

// @testing-library/react's auto-cleanup doesn't always fire with
// vitest's module-level render; call it explicitly so the previous
// test's DOM doesn't leak into the next (would cause "found multiple
// elements" errors on byRole queries).
afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────

describe('SkillProposalCard · active state', () => {
  it('renders skill name, description, and trigger reason', () => {
    renderCard();
    expect(screen.getByText('weekly-digest')).toBeInTheDocument();
    expect(screen.getByText('Generate a weekly Jira digest')).toBeInTheDocument();
    expect(screen.getByText(/8 tool calls succeeded/)).toBeInTheDocument();
  });

  it('expands the full SKILL.md preview on click', async () => {
    const user = userEvent.setup();
    renderCard();

    // Collapsed by default
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument();

    // Click the expand toggle. Tests run against en-US locale (the default
    // when no user language preference is persisted), so we match the
    // English copy — "View full content".
    await user.click(screen.getByRole('button', { name: /View full content/ }));
    const preview = await screen.findByTestId('markdown-preview');
    expect(preview).toHaveTextContent('Sample body for preview');
  });

  it('renders nothing for non-skill-proposal cards (forward-compat guard)', () => {
    const foreign = { ...SAMPLE_CARD, type: 'other-future-card' } as unknown as InteractiveNoticeCard;
    const { container } = render(
      <SkillProposalCard
        conversationId="c"
        messageId="m"
        toolCallId="t"
        card={foreign}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SkillProposalCard · accept', () => {
  it('calls acceptDraft with the card-captured workspace and commits action', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /^Accept$/ }));

    await waitFor(() => {
      expect(mockAcceptDraft).toHaveBeenCalledWith('weekly-digest', '/Users/test/myproj');
    });
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'accepted');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('surfaces a toast and does NOT commit when acceptDraft returns ok:false', async () => {
    mockAcceptDraft.mockResolvedValueOnce({ ok: false, error: 'duplicate skill name' });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /^Accept$/ }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'duplicate skill name' }),
      );
    });
    // Crucially: we did NOT settle the card to "accepted" — user can retry.
    expect(mockSetAction).not.toHaveBeenCalled();
  });
});

describe('SkillProposalCard · reject', () => {
  it('calls rejectDraft with card workspace and commits "rejected"', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /^Reject$/ }));

    await waitFor(() => {
      expect(mockRejectDraft).toHaveBeenCalledWith('weekly-digest', undefined, '/Users/test/myproj');
    });
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'rejected');
    // Memory write is only for "reject-category" — plain reject shouldn't fire it.
    expect(mockWriteMemory).not.toHaveBeenCalled();
  });
});

describe('SkillProposalCard · reject-category (writes feedback memory)', () => {
  it('rejects the draft AND writes a feedback memory so future proposals skip this category', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Don't propose this kind/ }));

    await waitFor(() => {
      expect(mockRejectDraft).toHaveBeenCalled();
    });
    // Options form with `category: true` so skillDraftsStore settles peer
    // cards with 'rejected-category' tone instead of plain 'rejected'
    // (Task #39 sync).
    expect(mockRejectDraft).toHaveBeenCalledWith(
      'weekly-digest',
      expect.objectContaining({
        category: true,
        workspaceOverride: '/Users/test/myproj',
      }),
    );
    // Feedback memory captures the skill name + description so Module F's
    // "scan feedback before proposing" guardrail can match on re-proposal.
    expect(mockWriteMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback',
        workspacePath: '/Users/test/myproj',
        name: expect.stringContaining('weekly-digest'),
        content: expect.stringContaining('weekly-digest'),
      }),
    );
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'rejected-category');
  });

  it('skips memory write but still settles the card when rejectDraft fails', async () => {
    mockRejectDraft.mockResolvedValueOnce({ ok: false, error: 'draft vanished' });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Don't propose this kind/ }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalled();
    });
    // Reject failed → no memory write, no settle commit.
    expect(mockWriteMemory).not.toHaveBeenCalled();
    expect(mockSetAction).not.toHaveBeenCalled();
  });

  it('still settles even if the memory write itself throws (best-effort side effect)', async () => {
    mockWriteMemory.mockRejectedValueOnce(new Error('memdir full'));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Don't propose this kind/ }));

    await waitFor(() => {
      expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'rejected-category');
    });
    // Draft was rejected successfully (primary intent honored), memory
    // failure is secondary — user still sees "settled" state.
  });
});

describe('SkillProposalCard · settled state', () => {
  it('accepted pill links to Toolbox with skill name prefilled (Task #33)', async () => {
    const user = userEvent.setup();
    renderCard({ settledAction: 'accepted' });

    // Settled text visible
    expect(screen.getByText('weekly-digest', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/✓ Accepted/)).toBeInTheDocument();
    // "→ Open skills panel" link hint visible + clickable
    const jump = screen.getByText(/→ Open skills panel/);
    expect(jump).toBeInTheDocument();

    await user.click(jump);
    expect(mockOpenToolbox).toHaveBeenCalledWith('skills');
    expect(mockSetToolboxSearchQuery).toHaveBeenCalledWith('weekly-digest');
  });

  it('rejected pill is non-interactive (no toolbox jump link)', () => {
    renderCard({ settledAction: 'rejected' });
    expect(screen.getByText(/Rejected \(in trash for 7 days\)/)).toBeInTheDocument();
    // The "→ Open skills panel" text only renders for accepted pills.
    expect(screen.queryByText(/→ Open skills panel/)).not.toBeInTheDocument();
    // Accept/reject buttons should NOT be rendered — settled = read-only.
    expect(screen.queryByRole('button', { name: /^Accept$/ })).not.toBeInTheDocument();
  });

  it('rejected-category pill shows the "this kind will not be proposed" variant', () => {
    renderCard({ settledAction: 'rejected-category' });
    expect(screen.getByText(/this kind will not be proposed/)).toBeInTheDocument();
  });

  it('deferred pill shows the "decide later" variant (Task #43)', () => {
    renderCard({ settledAction: 'deferred' });
    expect(screen.getByText(/Decide later · still available in drafts panel/)).toBeInTheDocument();
    // No toolbox jump link (only 'accepted' pills get that deep-link).
    expect(screen.queryByText(/→ Open skills panel/)).not.toBeInTheDocument();
    // Read-only — no accept / reject / defer buttons on settled pill.
    expect(screen.queryByRole('button', { name: /^Accept$/ })).not.toBeInTheDocument();
  });
});

describe('SkillProposalCard · first-use onboarding gate (Task #50)', () => {
  it('renders onboarding prompt when draftsOnboardingShown is false', () => {
    settingsState.soul.draftsOnboardingShown = false;
    renderCard();

    // Shows context (skill name + description) so user knows what
    // they're being asked about, but not the accept/reject buttons.
    expect(screen.getByText('weekly-digest')).toBeInTheDocument();
    expect(screen.getByText('Generate a weekly Jira digest')).toBeInTheDocument();
    expect(screen.getByText(/pick a proactivity level/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reject$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Decide later/ })).not.toBeInTheDocument();
  });

  it('clicking the gate button opens the Toolbox skills tab', async () => {
    settingsState.soul.draftsOnboardingShown = false;
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Open Toolbox/ }));
    expect(mockOpenToolbox).toHaveBeenCalledWith('skills');
  });

  it('settled actions take priority over the onboarding gate', () => {
    // Regression: if the user has already settled this card (pre-onboard,
    // against all odds), don't retroactively gate it behind onboarding.
    settingsState.soul.draftsOnboardingShown = false;
    renderCard({ settledAction: 'accepted' });

    expect(screen.queryByText(/pick a proactivity level/)).not.toBeInTheDocument();
    expect(screen.getByText(/Accepted/)).toBeInTheDocument();
  });

  it('once onboarding is done, the card renders normally', () => {
    settingsState.soul.draftsOnboardingShown = true;
    renderCard();

    expect(screen.queryByText(/pick a proactivity level/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decide later/ })).toBeInTheDocument();
  });
});

describe('SkillProposalCard · defer (Task #43)', () => {
  it('commits "deferred" without touching the draft filesystem', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: /Decide later/ }));

    // Crucially: defer must NOT call accept/reject — the draft stays
    // live so the user can still act on it from the drafts panel.
    expect(mockAcceptDraft).not.toHaveBeenCalled();
    expect(mockRejectDraft).not.toHaveBeenCalled();
    expect(mockSetAction).toHaveBeenCalledWith('conv-1', 'msg-1', 'tc-1', 'deferred');
  });
});

describe('SkillProposalCard · zombie-card detection (Task #40)', () => {
  it('shows "draft no longer exists" when draft is absent from store', () => {
    // Simulate user accepting draft via the Toolbox panel (or 72h TTL
    // sweeping it to trash) — draft is gone, but the chat card is still
    // mounted. Previously this left live buttons that would error on click.
    draftsStoreState.drafts = [];

    renderCard();

    expect(screen.getByText(/Draft no longer exists/)).toBeInTheDocument();
    // Action buttons must NOT render — card is read-only in missing state.
    expect(screen.queryByRole('button', { name: /^Accept$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reject$/ })).not.toBeInTheDocument();
  });

  it('settled state takes priority over missing — user action trace is preserved', () => {
    // Edge case: user clicked accept in the card, then separately deleted
    // the skill via Toolbox (draft gone from drafts list, skill also gone
    // from workspace-auto). Card should still honor the "accepted" trace
    // to match the user's own history.
    draftsStoreState.drafts = [];

    renderCard({ settledAction: 'accepted' });

    expect(screen.getByText(/✓ Accepted/)).toBeInTheDocument();
    // Deep-link from Task #33 still rendered.
    expect(screen.getByText(/→ Open skills panel/)).toBeInTheDocument();
    // Missing message should NOT appear — settled wins.
    expect(screen.queryByText(/Draft no longer exists/)).not.toBeInTheDocument();
  });

  it('suppresses "missing" flash on initial mount before store hydrates', () => {
    // First render may happen before listDrafts has finished populating.
    // We track lastRefreshedAt === null as "not yet initialized" and fall
    // through to the active state so the user doesn't see a false
    // "missing" state flash that then reverts to buttons a tick later.
    draftsStoreState.drafts = [];
    draftsStoreState.lastRefreshedAt = null;

    renderCard();

    // Active state: buttons rendered.
    expect(screen.getByRole('button', { name: /^Accept$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Draft no longer exists/)).not.toBeInTheDocument();
  });
});

// Task #41 · Agent silent patch notification. The card has no buttons
// and no settled state — it's a one-shot visibility surface so users
// see when Abu self-edits a skill instead of having to expand the
// tool call to notice.
describe('SkillProposalCard · skill-patched notice (Task #41)', () => {
  const PATCHED_CARD: InteractiveNoticeCard = {
    type: 'skill-patched',
    id: 'weekly-digest@1700000000000',
    skillPatched: {
      skillName: 'weekly-digest',
      filePath: '/abu/projects/ws/skills/weekly-digest/SKILL.md',
      summary: 'replace step 3 with fuzzy-match',
      workspacePath: '/Users/test/myproj',
    },
  };

  function renderPatched(card = PATCHED_CARD) {
    return render(
      <SkillProposalCard
        conversationId="conv-1"
        messageId="msg-1"
        toolCallId="tc-1"
        card={card}
      />,
    );
  }

  it('renders a muted pill with the skill name and summary, no buttons', () => {
    renderPatched();

    expect(screen.getByText('Abu patched skill')).toBeInTheDocument();
    expect(screen.getByText('weekly-digest')).toBeInTheDocument();
    expect(screen.getByText(/replace step 3 with fuzzy-match/)).toBeInTheDocument();
    // Read-only: no accept / reject / category buttons on patch cards.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('omits the summary span when payload has no summary', () => {
    const { skillPatched, ...rest } = PATCHED_CARD;
    const noSummary: InteractiveNoticeCard = {
      ...rest,
      skillPatched: { ...skillPatched!, summary: undefined },
    };
    renderPatched(noSummary);

    expect(screen.getByText('Abu patched skill')).toBeInTheDocument();
    expect(screen.getByText('weekly-digest')).toBeInTheDocument();
    // No em-dash summary separator when summary is absent.
    expect(screen.queryByText(/—/)).not.toBeInTheDocument();
  });
});
