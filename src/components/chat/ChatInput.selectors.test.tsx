// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatInput from './ChatInput';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore } from '@/stores/teamStore';
import { clearAllComposerDrafts, getComposerDraftKey, writeComposerDraft } from '@/stores/composerDraftStore';
import { getI18n } from '@/i18n';
import type { ProviderInstance } from '@/types/provider';

vi.mock('@/utils/electronHost', () => ({
  hasElectronCommandHost: vi.fn(() => false),
  hasElectronRawBodyInvoke: vi.fn(() => false),
  hasElectronUserAttachmentAuthorizeHost: vi.fn(() => false),
  hasElectronUserAttachmentSelectHost: vi.fn(() => false),
  authorizeElectronUserAttachment: vi.fn(),
  selectElectronUserAttachments: vi.fn(),
  readElectronUserAttachment: vi.fn(),
  hasElectronUserAttachmentReleaseHost: vi.fn(() => false),
  releaseElectronUserAttachment: vi.fn(),
  getElectronFilePath: vi.fn(() => null),
  canonicalizeElectronPathForPolicy: vi.fn(async () => null),
}));

const popoverRenders = vi.hoisted(() => vi.fn());

// Counts renders of the toolbar's floating layers: the model picker's Popover and the
// permission chip's Menu.
vi.mock('@/components/ds/popover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/popover')>();
  return {
    ...actual,
    Popover: (props: ComponentProps<typeof actual.Popover>) => {
      popoverRenders('popover');
      return actual.Popover(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      popoverRenders('menu');
      return actual.Menu(props);
    },
  };
});

const tooltipRenders = vi.hoisted(() => vi.fn());

// Records the text of every hover tip that renders, to tell the composer's own tips apart
// from the context ring's (which follows live usage by design).
vi.mock('@/components/ds/tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/tooltip')>();
  return {
    ...actual,
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      tooltipRenders(props.content);
      return actual.Tooltip(props);
    },
  };
});

const PROVIDER: ProviderInstance = {
  id: 'p1',
  source: 'custom',
  name: 'Loopback',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: 'test-key-not-a-secret',
  models: [{ id: 'm1', label: 'Model One' }, { id: 'm2', label: 'Model Two' }],
  status: 'verified',
  sortOrder: 0,
  userAdded: true,
};

describe('composer selectors', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    useChatStore.setState({ conversations: {}, activeConversationId: null });
    useTeamStore.setState({ teams: [] });
    useSettingsStore.setState({
      providers: [PROVIDER],
      activeModel: { providerId: 'p1', modelId: 'm1' },
      recentModels: [],
      favoriteModels: [],
      permissionMode: 'standard',
      composerEnterBehavior: 'enter',
    });
    clearAllComposerDrafts();
    popoverRenders.mockClear();
    tooltipRenders.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('closes the model picker when the permission list opens', async () => {
    const user = userEvent.setup();
    useChatStore.getState().createConversation();
    render(<ChatInput variant="chat" onSend={vi.fn()} />, { wrapper: DesignSystemProvider });

    await user.click(screen.getByRole('button', { name: 'Model One' }));
    expect(await screen.findByRole('textbox', { name: `${getI18n().common.search}...` })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: getI18n().settings.permissionModeStandard }));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: `${getI18n().common.search}...` })).not.toBeInTheDocument();
  });

  it('keeps the model picker and permission chip still while a reply streams', () => {
    const id = useChatStore.getState().createConversation();
    render(<ChatInput variant="chat" onSend={vi.fn()} />, { wrapper: DesignSystemProvider });
    const initial = popoverRenders.mock.calls.length;
    expect(popoverRenders).toHaveBeenCalledWith('popover');
    expect(popoverRenders).toHaveBeenCalledWith('menu');

    // Two streamed tokens: the active conversation object changes, and the composer with it.
    for (const text of ['Hel', 'Hello']) {
      act(() => {
        useChatStore.setState((state) => ({
          conversations: {
            ...state.conversations,
            [id]: {
              ...state.conversations[id]!,
              messages: [{ id: 'a1', role: 'assistant', content: text, timestamp: 1 }],
            },
          },
        }));
      });
    }

    expect(popoverRenders).toHaveBeenCalledTimes(initial);
  });

  it('keeps the + menu, chips, attachments and send button still while the user types', () => {
    const id = useChatStore.getState().createConversation();
    writeComposerDraft(getComposerDraftKey(id), {
      text: '',
      images: [{ id: 'img-1', data: 'aGVsbG8=', mediaType: 'image/png' }],
      files: [{ id: 'file-1', path: '/work/notes.md', name: 'notes.md' }],
      references: [],
      selectedSkill: null,
      selectedAgent: { name: 'publisher', description: 'Draft posts' },
    });
    render(<ChatInput variant="chat" onSend={vi.fn()} />, { wrapper: DesignSystemProvider });
    const { chat, common, toolbox } = getI18n();
    const ownTips = new Set<unknown>([chat.composerMenu.open, common.close, toolbox.menuRemove, chat.removeImage, chat.sendTooltipEnterSends]);
    expect(tooltipRenders.mock.calls.filter(([content]) => ownTips.has(content)).length).toBeGreaterThanOrEqual(5);

    const box = screen.getByRole('textbox');
    // The first character may enable send; the following ones change nothing around the field.
    act(() => { fireEvent.change(box, { target: { value: 'h' } }); });
    const menusBefore = popoverRenders.mock.calls.length;
    tooltipRenders.mockClear();
    for (const value of ['he', 'hel', 'hell']) {
      act(() => { fireEvent.change(box, { target: { value } }); });
    }

    expect(popoverRenders).toHaveBeenCalledTimes(menusBefore);
    expect(tooltipRenders.mock.calls.filter(([content]) => ownTips.has(content))).toEqual([]);
  });
});
