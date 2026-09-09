// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ChatInput from './ChatInput';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { getI18n } from '@/i18n';

vi.mock('@/utils/electronHost', () => ({
  hasElectronCommandHost: vi.fn(() => false),
  hasElectronUserAttachmentAuthorizeHost: vi.fn(() => false),
  hasElectronUserAttachmentSelectHost: vi.fn(() => false),
  authorizeElectronUserAttachment: vi.fn(),
  selectElectronUserAttachments: vi.fn(),
  readElectronUserAttachment: vi.fn(),
  hasElectronUserAttachmentReleaseHost: vi.fn(() => false),
  releaseElectronUserAttachment: vi.fn(),
  getElectronFilePath: vi.fn(() => null),
}));

/* The composer toolbar has to survive a narrow center pane — the workspace
   panel can squeeze it to ~300px while the window itself stays wide. It used
   to `flex-wrap`, which CSS resolves against content size *before* it shrinks
   anything, so the whole right half dropped onto a second line instead of the
   model name truncating. The fix is a single row that gives up space in a
   fixed order, driven by container queries on the toolbar itself.

   Container queries don't evaluate in happy-dom, so these tests pin the two
   things that survive without a layout engine: the structural choice that
   caused the bug, and the guarantee that collapsing a label doesn't cost the
   control its name. The visual ladder itself is verified in the Electron
   shell at real widths. */
describe('composer toolbar in a narrow pane', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, activeConversationId: null });
    useTeamStore.setState({ teams: [] });
  });

  afterEach(() => {
    cleanup();
    useTeamStore.setState({ teams: [] });
    vi.restoreAllMocks();
  });

  it.each(['chat', 'welcome'] as const)(
    'lays the %s toolbar out as one container-queried row, never a wrapping one',
    (variant) => {
      if (variant === 'chat') useChatStore.getState().createConversation();
      render(<ChatInput variant={variant} onSend={vi.fn()} />);

      const toolbar = screen.getByTestId('composer-toolbar');
      // The regression itself: wrapping pre-empts shrinking, so the row breaks
      // apart instead of truncating.
      expect(toolbar.className).not.toContain('flex-wrap');
      // Width has to be read off the toolbar, not the window — the window is
      // wide precisely when this pane is narrow.
      expect(toolbar.className).toContain('@container');
    },
  );

  it('keeps the permission mode readable by assistive tech once its label collapses', () => {
    useChatStore.getState().createConversation();
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    // The label is display:none at narrow widths, which takes it out of the
    // accessibility tree too — so the name must not depend on it.
    const { settings } = getI18n();
    const chip = screen.getByRole('button', {
      name: `${settings.permissionMode}: ${settings.permissionModeStandard}`,
    });
    expect(chip.querySelector('.\\@max-\\[420px\\]\\:hidden')).not.toBeNull();
  });

  /* The chat column now keeps a floor (clampNarrowPanelWidth), so on a normal
     window the ring's own rung is only reached in the corner the floor cannot
     protect — a 900px window with the sidebar open, where the panel yields to
     its own minimum instead. That is out of reach of the Electron guard, so
     pin the wiring here. */
  it('marks the context ring as the rung below the permission label', () => {
    useChatStore.getState().createConversation();
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    const toolbar = screen.getByTestId('composer-toolbar');
    const ring = toolbar.querySelector('.\\@max-\\[360px\\]\\:hidden');
    expect(ring, 'the context ring lost its degradation rung').not.toBeNull();
    // Ordering is the whole design: the ring may only go after the permission
    // label has already collapsed, never before.
    expect(toolbar.querySelector('.\\@max-\\[420px\\]\\:hidden')).not.toBeNull();
  });

  it('keeps the pinned team identifiable by its avatar once the name collapses', () => {
    const id = useChatStore.getState().createConversation();
    useTeamStore.setState({
      teams: [{ id: 't1', name: '网页开发专家团', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }],
    });
    useChatStore.getState().setConversationTeamId(id, 't1');
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    const chip = screen.getByTestId('composer-team-chip');
    expect(chip).toHaveAccessibleName('👥网页开发专家团');
    expect(chip.querySelector('.\\@max-\\[330px\\]\\:hidden')?.textContent).toBe('网页开发专家团');
  });
});
