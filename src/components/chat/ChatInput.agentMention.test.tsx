// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChatInput from './ChatInput';
import { clearAllComposerDrafts, writeComposerDraft, WELCOME_COMPOSER_DRAFT_KEY } from '@/stores/composerDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ImageAttachment, Skill } from '@/types';
import { clearInputQueue, getQueuedInputs } from '@/core/agent/userInputQueue';

const AGENTS = [
  { name: 'publisher', description: 'Draft and edit public posts' },
  { name: 'planner', description: 'Plan work' },
];

const SKILLS: Skill[] = [{
  name: 'brief',
  description: 'Create a brief',
  content: '',
  filePath: '/skills/brief/SKILL.md',
  skillDir: '/skills/brief',
}];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

function typeAtCaret(textarea: HTMLTextAreaElement, value: string, caret = value.length): void {
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(caret, caret);
  fireEvent.select(textarea);
}

function expectAgentPicker(open: boolean): void {
  if (open) {
    expect(screen.getByRole('option', { name: /publisher/ })).toBeTruthy();
  } else {
    expect(screen.queryByRole('option', { name: /publisher/ })).toBeNull();
  }
}

describe('ChatInput inline @mention boundaries', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      pendingInput: null,
      pendingInputAppend: null,
      pendingReferences: [],
      pendingAttachmentRequests: [],
    });
    useDiscoveryStore.setState({ skills: [], agents: AGENTS, isLoading: false });
    useSettingsStore.setState({ composerEnterBehavior: 'enter', disabledAgents: [], disabledSkills: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
    for (const conversationId of Object.keys(useChatStore.getState().conversations)) {
      clearInputQueue(conversationId);
    }
  });

  it.each([
    ['at the start', '@'],
    ['after whitespace', 'draft @'],
    ['after punctuation', 'draft，@'],
    ['directly after CJK text', '帮我@'],
  ])('opens an agent picker %s', (_label, value) => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, value);
    expectAgentPicker(true);
  });

  it('exposes the inline agent picker as an active listbox option', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');

    const listbox = screen.getByRole('listbox');
    const option = screen.getByRole('option', { name: /publisher/ });
    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-controls', listbox.id);
    expect(textarea).toHaveAttribute('aria-activedescendant', option.id);
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(option.tagName).toBe('BUTTON');
  });

  it('keeps the active agent option visible while Arrow navigation wraps a long list', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    useDiscoveryStore.setState({
      agents: Array.from({ length: 12 }, (_, index) => ({
        name: `agent-${index}`,
        description: `Agent ${index}`,
      })),
    });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@');
    scrollIntoView.mockClear();

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });

    const active = screen.getByRole('option', { name: /agent-11/ });
    expect(textarea).toHaveAttribute('aria-activedescendant', active.id);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it.each([
    'hello@publisher.com',
    'prefix@publisher',
    '用户@publisher.com',
  ])('does not treat an ASCII local-part adjacency as a mention: %s', (value) => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, value);
    expectAgentPicker(false);
  });

  it('closes the picker when selection moves the caret outside the active token', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    typeAtCaret(textarea, '@pub');
    expectAgentPicker(true);
    textarea.setSelectionRange(0, 0);
    fireEvent.select(textarea);
    expectAgentPicker(false);
  });

  it('closes the picker for a non-collapsed selection inside the active token', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    typeAtCaret(textarea, '@pub');
    expectAgentPicker(true);
    textarea.setSelectionRange(1, 3);
    fireEvent.select(textarea);
    expectAgentPicker(false);
  });

  it('does not intercept Enter in an email and sends the original text unchanged', () => {
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, 'hello@publisher');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello@publisher', undefined, null, expect.any(Function));
    expect(textarea.value).toBe('');
  });

  it('does not let a stale candidate select an agent after the DOM token changes without React state', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@');
    const staleCandidate = screen.getByRole('option', { name: /publisher/ });

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter?.call(textarea, 'plain text');
    textarea.setSelectionRange(10, 10);
    fireEvent.click(staleCandidate);

    expect(screen.queryByRole('button', { name: '@publisher' })).toBeNull();
    expect(textarea.value).toBe('plain text');
  });

  it('reopens after Escape when the active mention token changes but result count does not', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    expectAgentPicker(true);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expectAgentPicker(false);

    typeAtCaret(textarea, '@publ');
    expectAgentPicker(true);
  });

  it('does not reopen an escaped leading @agent suggestion when only its body changes', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub task');
    expectAgentPicker(true);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expectAgentPicker(false);

    typeAtCaret(textarea, '@pub task revised');
    expectAgentPicker(false);

    typeAtCaret(textarea, '@publ task revised');
    expectAgentPicker(true);
  });

  it('keeps an escaped leading token dismissed when a body is added after the bare command', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    expectAgentPicker(true);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expectAgentPicker(false);

    typeAtCaret(textarea, '@pub task');
    expectAgentPicker(false);

    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    expectAgentPicker(false);
  });

  it('leaves the picker keyboard untouched during IME composition and restores it afterwards', () => {
    vi.useFakeTimers();
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@');
    expectAgentPicker(true);

    fireEvent.compositionStart(textarea);
    expectAgentPicker(false);
    expect(fireEvent.keyDown(textarea, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true);
    expect(screen.queryByRole('button', { name: '@publisher' })).toBeNull();

    fireEvent.compositionEnd(textarea);
    act(() => { vi.advanceTimersByTime(0); });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it.each(['welcome', 'chat'] as const)('selects an agent inline in the %s composer', (variant) => {
    if (variant === 'chat') useChatStore.getState().createConversation();
    render(<ChatInput variant={variant} onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');

    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it('restores selectedAgent and its body when a dispatch rejects', async () => {
    const onSend = vi.fn(async (
      _message: string,
      _images?: ImageAttachment[],
      _workspacePath?: string | null,
    ): Promise<boolean> => false);
    render(<ChatInput variant="welcome" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));
    typeAtCaret(textarea, 'write this');

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith('@publisher write this', undefined, null, expect.any(Function));
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
    expect(textarea.value).toBe('write this');
  });

  it('keeps selectedAgent after a successful existing-conversation send', async () => {
    useChatStore.getState().createConversation();
    const onSend = vi.fn(async (): Promise<boolean> => true);
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));
    typeAtCaret(textarea, 'write this');

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith('@publisher write this', undefined, undefined, expect.any(Function));
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
    expect(textarea).toHaveValue('');
  });

  it('hydrates an AgentsSection pending @agent prompt into a chip plus body', () => {
    useChatStore.getState().setPendingInput('@publisher draft the launch post');
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft the launch post');
    expect(useChatStore.getState().pendingInput).toBeNull();
  });

  it('does not offer a slash picker for an inline skill token in message prose', () => {
    useDiscoveryStore.setState({ skills: SKILLS });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, '正文 /brief');

    expect(screen.queryByRole('option', { name: /brief/ })).toBeNull();
  });

  it('continues to offer and select a leading slash skill command', () => {
    useDiscoveryStore.setState({ skills: SKILLS });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '/br');

    const listbox = screen.getByRole('listbox');
    const option = screen.getByRole('option', { name: /brief/ });
    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-controls', listbox.id);
    expect(textarea).toHaveAttribute('aria-activedescendant', option.id);
    expect(option).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: /brief/ }));
    expect(screen.getByRole('button', { name: '/brief' })).toBeTruthy();
  });

  it('keeps the leading slash skill picker ahead of an inline @agent candidate', () => {
    useDiscoveryStore.setState({ skills: SKILLS });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    typeAtCaret(screen.getByRole('textbox') as HTMLTextAreaElement, '/brief @pub');

    expect(screen.getByRole('button', { name: /brief/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /publisher/ })).toBeNull();
  });

  it('replaces only a middle @mention token and preserves the surrounding prose', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    const value = 'before @pub after';
    const tokenEnd = 'before @pub'.length;
    typeAtCaret(textarea, value, tokenEnd);

    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe('before  after');
    expect(textarea.selectionStart).toBe('before '.length);
    expect(textarea.selectionEnd).toBe('before '.length);
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it.each([
    ['请 @pub，润色', '请 ，润色'],
    ['before @pub，after', 'before ，after'],
  ])('removes only the @token while preserving punctuation and prose: %s', (value, expected) => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, value, value.indexOf('@') + '@pub'.length);

    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe(expected);
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it('syncs the real textarea caret for a same-value pending input before selecting an agent', () => {
    const value = 'draft @pub';
    writeComposerDraft(WELCOME_COMPOSER_DRAFT_KEY, {
      text: value,
      images: [],
      files: [],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);

    act(() => { useChatStore.getState().setPendingInput(value); });

    expect(textarea.selectionStart).toBe(value.length);
    expect(textarea.selectionEnd).toBe(value.length);
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
    expect(textarea.value).toBe('draft ');
  });

  it('releases same-value pending-input caret synchronization after it is applied', () => {
    const value = 'draft @pub';
    writeComposerDraft(WELCOME_COMPOSER_DRAFT_KEY, {
      text: value,
      images: [],
      files: [],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    act(() => { useChatStore.getState().setPendingInput(value); });
    expectAgentPicker(true);

    textarea.setSelectionRange(0, 0);
    fireEvent.select(textarea);
    expectAgentPicker(false);
  });


  it('preserves a non-PDF path attachment when sending to an inline agent', () => {
    const attachment = { id: 'file-1', path: '/private/project/plan.docx', name: 'plan.docx' };
    writeComposerDraft(WELCOME_COMPOSER_DRAFT_KEY, {
      text: 'review this',
      images: [],
      files: [attachment],
      references: [],
      selectedSkill: null,
      selectedAgent: { name: 'publisher', description: 'Draft and edit public posts' },
    });
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith(
      '@publisher [Attachment: `/private/project/plan.docx`]\n\nreview this',
      undefined,
      null,
      expect.any(Function),
    );
  });


  it('queues an agent-prefixed message rather than dispatching while chat is running', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const conversationId = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    const onSend = vi.fn();
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));
    typeAtCaret(textarea, 'queued body');

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(getQueuedInputs(conversationId).map((entry) => entry.text)).toEqual(['@publisher queued body']);
    expect(onSend).not.toHaveBeenCalled();
    clearInputQueue(conversationId);
  });

  it('restores an agent-selected composer draft when switching A → B → A', async () => {
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation(undefined, { skipActivate: true });
    render(<ChatInput variant="chat" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeAtCaret(textarea, '@pub');
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));
    typeAtCaret(textarea, 'A body');

    await act(async () => { await useChatStore.getState().switchConversation(b); });
    expect(screen.queryByRole('button', { name: '@publisher' })).toBeNull();
    expect(textarea.value).toBe('');

    await act(async () => { await useChatStore.getState().switchConversation(a); });
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
    expect(textarea.value).toBe('A body');
  });
});
