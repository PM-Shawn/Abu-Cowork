// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatInput, {
  mergeComposerAppend,
  referenceDedupeKey,
  referenceChipLabel,
} from './ChatInput';
import { mergeFileAttachments } from './composerFileAttachments';
import { readFile } from '@tauri-apps/plugin-fs';
import { createDocReference, createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';
import { useChatStore } from '@/stores/chatStore';
import {
  clearAllComposerDrafts,
  getComposerDraftKey,
  readComposerDraft,
  writeComposerDraft,
  WELCOME_COMPOSER_DRAFT_KEY,
} from '@/stores/composerDraftStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { getI18n } from '@/i18n';
import type { ImageAttachment } from '@/types';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import type { EnterpriseBinding } from '@/core/enterprise/types';
import { shouldRestoreComposerAfterDispatch } from './composerSendResult';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { clearInputQueue, getQueuedInputs } from '@/core/agent/userInputQueue';
import { useToastStore } from '@/stores/toastStore';

const electronHostMocks = vi.hoisted(() => ({
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

vi.mock('@/utils/electronHost', () => electronHostMocks);

const ONE_BY_ONE_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
) as Uint8Array<ArrayBuffer>;
const FUTURE_ATTACHMENT_EXPIRY = 4_102_444_800_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const enterpriseBinding = (userId: string): EnterpriseBinding => ({
  serverUrl: 'https://example.test',
  orgId: 'org-1',
  orgName: 'Example',
  userId,
  userName: userId,
  userEmail: `${userId}@example.test`,
  deptId: null,
  roleId: null,
  accessToken: 'test-token',
  boundAt: '2026-08-04T00:00:00.000Z',
  llmEndpoint: null,
  llmVirtualKey: null,
  llmKeyExpiresAt: null,
});

describe('ChatInput per-conversation drafts', () => {
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
    useImageLightboxStore.getState().close();
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    useImageLightboxStore.getState().close();
    useToastStore.setState(useToastStore.getInitialState(), true);
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores the textarea value after switching A → B → A', async () => {
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation(undefined, { skipActivate: true });
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft from A' } });

    await act(async () => {
      await useChatStore.getState().switchConversation(b);
    });
    expect(textarea.value).toBe('');
    fireEvent.change(textarea, { target: { value: 'draft from B' } });

    await act(async () => {
      await useChatStore.getState().switchConversation(a);
    });
    expect(textarea.value).toBe('draft from A');
  });

  it('isolates and restores drafts when switching between local and enterprise users', async () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'local draft' } });
    act(() => {
      useEnterpriseStore.setState({
        mode: { kind: 'enterprise', binding: enterpriseBinding('alice'), config: null },
      });
    });
    expect(textarea.value).toBe('');

    fireEvent.change(textarea, { target: { value: 'alice draft' } });
    act(() => {
      useEnterpriseStore.setState({
        mode: { kind: 'enterprise', binding: enterpriseBinding('bob'), config: null },
      });
    });
    expect(textarea.value).toBe('');

    fireEvent.change(textarea, { target: { value: 'bob draft' } });
    act(() => {
      useEnterpriseStore.setState({ mode: { kind: 'personal' } });
    });
    expect(textarea.value).toBe('local draft');

    act(() => {
      useEnterpriseStore.setState({
        mode: { kind: 'enterprise', binding: enterpriseBinding('alice'), config: null },
      });
    });
    expect(textarea.value).toBe('alice draft');
  });

  it.each([
    ['missing API key', () => Promise.resolve(false)],
    [
      'busy conversation',
      () => Promise.resolve(
        shouldRestoreComposerAfterDispatch({
          reason: 'error',
          error: 'conversation busy',
          messageTaken: false,
        }) ? false : undefined,
      ),
    ],
  ])('restores the welcome draft when %s rejects the send', async (_scenario, onSend) => {
    render(<ChatInput variant="welcome" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(textarea.value).toBe('hello');
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('hello');
  });

  it('keeps the welcome draft empty after a post-commit run failure', async () => {
    const onSend = vi.fn(() => Promise.resolve(
      shouldRestoreComposerAfterDispatch({
        reason: 'error',
        error: 'provider unavailable',
        messageTaken: true,
      }) ? false : undefined,
    ));
    render(<ChatInput variant="welcome" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith('hello', undefined, null, expect.any(Function));
    expect(textarea.value).toBe('');
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('');
  });

  it.each([
    ['returns false', (resolve: (accepted: boolean) => void, _reject: (reason?: unknown) => void) => resolve(false)],
    ['rejects', (_resolve: (accepted: boolean) => void, reject: (reason?: unknown) => void) => reject(new Error('send failed'))],
  ])('restores a send that %s to its original conversation without clobbering the active draft', async (_outcome, settle) => {
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation(undefined, { skipActivate: true });
    const draftKeyA = getComposerDraftKey(a);
    const draftKeyB = getComposerDraftKey(b);
    let settleSend: (() => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve, reject) => {
      settleSend = () => settle(resolve, reject);
    }));

    writeComposerDraft(draftKeyB, {
      text: 'draft from B',
      images: [],
      files: [{ id: 'b-pdf', path: '/private/B.pdf', name: 'B.pdf' }],
      references: [],
      selectedSkill: null,
      selectedAgent: { name: 'b-agent', description: 'B agent' },
    });
    render(<ChatInput variant="chat" onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft from A' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      await useChatStore.getState().switchConversation(b);
    });
    expect(textarea.value).toBe('draft from B');
    expect(screen.getByText('B.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '@b-agent' })).toBeTruthy();

    await act(async () => {
      settleSend?.();
      await Promise.resolve();
    });

    expect(readComposerDraft(draftKeyA).text).toBe('draft from A');
    expect(textarea.value).toBe('draft from B');
    expect(screen.getByText('B.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '@b-agent' })).toBeTruthy();
  });

  it.each([
    ['returns false', (deferredSend: ReturnType<typeof deferred<boolean | void>>) => deferredSend.resolve(false)],
    ['rejects', (deferredSend: ReturnType<typeof deferred<boolean | void>>) => deferredSend.reject(new Error('send failed'))],
  ])('does not clobber new same-conversation typing or dispatch concurrently when a send %s', async (_outcome, settle) => {
    const conversationId = useChatStore.getState().createConversation();
    const send = deferred<boolean | void>();
    const onSend = vi.fn(() => send.promise);
    render(<ChatInput variant="chat" onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'first message' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');

    // Typed while the initial send is still pending — staged for the queue
    // rather than dispatched concurrently or dropped.
    fireEvent.change(textarea, { target: { value: 'new draft while pending' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(getQueuedInputs(conversationId).map((entry) => entry.text))
      .toEqual(['new draft while pending']);
    expect(textarea.value).toBe('');

    await act(async () => {
      settle(send);
      try {
        await send.promise;
      } catch {
        // Rejection is the behavior under test.
      }
      await Promise.resolve();
    });

    // The failed initial send hands its own draft back; the staged follow-up
    // stays in the queue untouched.
    expect(textarea.value).toBe('first message');
    expect(readComposerDraft(getComposerDraftKey(useChatStore.getState().activeConversationId)).text)
      .toBe('first message');
    expect(getQueuedInputs(conversationId).map((entry) => entry.text))
      .toEqual(['new draft while pending']);
    clearInputQueue(conversationId);
  });

  it('queues a pure-text follow-up while a previous initial send promise is still pending and the chat is running', async () => {
    const conversationId = useChatStore.getState().createConversation();
    const pending = deferred<boolean | void>();
    const onSend = vi.fn(() => pending.promise);
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'start work' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    act(() => {
      useChatStore.getState().setConversationStatus(conversationId, 'running');
    });
    fireEvent.change(textarea, { target: { value: 'follow up while running' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(getQueuedInputs(conversationId).map((entry) => entry.text)).toEqual(['follow up while running']);
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    clearInputQueue(conversationId);
  });

  it('releases the pending-send lock at acceptance so a new draft can dispatch mid-run', async () => {
    // Mirrors the welcome composer's shared draft key: task A's run may take
    // minutes, and the "new task" composer must not silently drop task B for
    // that whole time. Once A's message is accepted (onAccepted fired), B
    // dispatches immediately.
    useChatStore.getState().createConversation();
    const firstRun = deferred<boolean | void>();
    const onSend = vi.fn((
      _message: string,
      _images?: unknown,
      _workspace?: unknown,
      onAccepted?: () => void,
    ) => {
      onAccepted?.();
      return firstRun.promise;
    });
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'task A' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.change(textarea, { target: { value: 'task B' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1][0]).toBe('task B');
    expect(textarea.value).toBe('');

    await act(async () => {
      firstRun.resolve(true);
      await firstRun.promise;
    });
  });

  it('stages a follow-up typed in the post-run settling window instead of dropping it', async () => {
    // Reproduces the task-lifecycle e2e race: the run has already published its
    // terminal (status left 'running'), but the initial dispatch promise has
    // not resolved yet, so the composer's pending-send guard is still held.
    // An Enter in that window must stage the message for the live dispatcher's
    // final queue drain — not vanish behind a toast with the draft left behind.
    const conversationId = useChatStore.getState().createConversation();
    const pending = deferred<boolean | void>();
    const onSend = vi.fn(() => pending.promise);
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'start work' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    act(() => {
      useChatStore.getState().setConversationStatus(conversationId, 'running');
      useChatStore.getState().setConversationStatus(conversationId, 'completed');
    });
    fireEvent.change(textarea, { target: { value: 'follow up in settling window' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(getQueuedInputs(conversationId).map((entry) => entry.text))
      .toEqual(['follow up in settling window']);
    expect(textarea.value).toBe('');
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    clearInputQueue(conversationId);
  });

  it('stages a second non-running dispatch attempt while the first send is still pending', () => {
    const conversationId = useChatStore.getState().createConversation();
    const pending = deferred<boolean | void>();
    const onSend = vi.fn(() => pending.promise);
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'first' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.change(textarea, { target: { value: 'second' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(getQueuedInputs(conversationId).map((entry) => entry.text)).toEqual(['second']);
    expect(textarea.value).toBe('');
    expect(useToastStore.getState().toasts).toEqual([]);
    clearInputQueue(conversationId);
  });

  it('refuses to queue a PDF attachment while the conversation is running and preserves the draft', () => {
    const conversationId = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    const draftKey = getComposerDraftKey(conversationId);
    writeComposerDraft(draftKey, {
      text: 'review the PDF',
      images: [],
      files: [{ id: 'file-1', path: '/private/report.pdf', name: 'report.pdf' }],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    const onSend = vi.fn();

    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(getQueuedInputs(conversationId)).toEqual([]);
    expect(textarea.value).toBe('review the PDF');
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(readComposerDraft(draftKey).files).toEqual([
      { id: 'file-1', path: '/private/report.pdf', name: 'report.pdf' },
    ]);
    clearInputQueue(conversationId);
  });

  it('preserves the legacy path context when sending a non-PDF workspace file', () => {
    const conversationId = useChatStore.getState().createConversation();
    const draftKey = getComposerDraftKey(conversationId);
    writeComposerDraft(draftKey, {
      text: 'summarize this file',
      images: [],
      files: [{ id: 'notes-txt', path: '/workspace/notes.txt', name: 'notes.txt' }],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    const onSend = vi.fn();

    render(<ChatInput variant="chat" onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith(
      '[Attachment: `/workspace/notes.txt`]\n\nsummarize this file',
      undefined,
      undefined,
      expect.any(Function),
    );
  });
});

describe('ChatInput attachment image preview', () => {
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
    useImageLightboxStore.getState().close();
  });

  afterEach(() => {
    useImageLightboxStore.getState().close();
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens pending images in the lightbox without changing the preview panel', () => {
    const images: ImageAttachment[] = [
      { id: 'img-1', data: 'aGVsbG8=', mediaType: 'image/png' },
      { id: 'img-2', data: 'd29ybGQ=', mediaType: 'image/webp' },
    ];
    writeComposerDraft(WELCOME_COMPOSER_DRAFT_KEY, {
      text: '',
      images,
      files: [],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    const openPreview = vi.fn();
    usePreviewStore.setState({ openPreview });

    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    const thumbnails = screen.getAllByTitle(getI18n().chat.clickToViewFull);
    fireEvent.click(thumbnails[1]);

    const lightbox = useImageLightboxStore.getState();
    expect(lightbox.isOpen).toBe(true);
    expect(lightbox.activeIndex).toBe(1);
    expect(lightbox.items.map((item) => item.id)).toEqual(['img-1', 'img-2']);
    expect(lightbox.returnFocus).toBe(thumbnails[1]);
    expect(openPreview).not.toHaveBeenCalled();

    useImageLightboxStore.getState().close();
    fireEvent.click(screen.getAllByTitle(getI18n().chat.removeImage)[0]);
    expect(useImageLightboxStore.getState().isOpen).toBe(false);
    expect(screen.getAllByTitle(getI18n().chat.clickToViewFull)).toHaveLength(1);
  });
});

describe('ChatInput Electron attachment picker and clipboard boundary', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    vi.clearAllMocks();
    electronHostMocks.hasElectronCommandHost.mockReturnValue(false);
    electronHostMocks.hasElectronUserAttachmentAuthorizeHost.mockReturnValue(false);
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(false);
    electronHostMocks.hasElectronUserAttachmentReleaseHost.mockReturnValue(false);
    electronHostMocks.releaseElectronUserAttachment.mockResolvedValue({ released: true });
    electronHostMocks.getElectronFilePath.mockReturnValue(null);
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
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    useToastStore.setState(useToastStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it('does not admit an Electron-picked PDF into the composer or send payload', async () => {
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(true);
    electronHostMocks.selectElectronUserAttachments.mockResolvedValueOnce([{
      token: 'p'.repeat(43),
      name: 'plan.pdf',
      mediaType: 'application/pdf',
      expiresAt: FUTURE_ATTACHMENT_EXPIRY,
    }]);
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText(getI18n().chat.addAttachment));
    await waitFor(() => expect(electronHostMocks.selectElectronUserAttachments).toHaveBeenCalled());
    expect(screen.queryByText('plan.pdf')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'review' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][3]).toEqual(expect.any(Function));
    expect(electronHostMocks.authorizeElectronUserAttachment).not.toHaveBeenCalled();
  });

  it('reads an Electron-picked PNG token into an image attachment without exposing a raw path', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(true);
    electronHostMocks.selectElectronUserAttachments.mockResolvedValueOnce([{
      token: 'i'.repeat(43),
      name: 'pixel.png',
      mediaType: 'image/png',
      expiresAt: FUTURE_ATTACHMENT_EXPIRY,
    }]);
    electronHostMocks.readElectronUserAttachment.mockResolvedValueOnce(png);
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText(getI18n().chat.addAttachment));
    await waitFor(() => expect(electronHostMocks.readElectronUserAttachment).toHaveBeenCalledWith({ token: 'i'.repeat(43) }));
    await waitFor(() => expect(screen.getByTitle(getI18n().chat.clickToViewFull)).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(electronHostMocks.selectElectronUserAttachments).toHaveBeenCalledWith({
      mediaTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toEqual([
      expect.objectContaining({ mediaType: 'image/png' }),
    ]);
    expect(onSend.mock.calls[0][3]).toEqual(expect.any(Function));
  });

  it('releases an Electron image token after the selected image is materialized', async () => {
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(true);
    electronHostMocks.hasElectronUserAttachmentReleaseHost.mockReturnValue(true);
    electronHostMocks.selectElectronUserAttachments.mockResolvedValueOnce([{
      token: 'i'.repeat(43),
      name: 'pixel.png',
      mediaType: 'image/png',
      expiresAt: FUTURE_ATTACHMENT_EXPIRY,
    }]);
    electronHostMocks.readElectronUserAttachment.mockResolvedValueOnce(ONE_BY_ONE_PNG);
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(getI18n().chat.addAttachment));

    await waitFor(() => expect(electronHostMocks.releaseElectronUserAttachment).toHaveBeenCalledWith({
      token: 'i'.repeat(43),
    }));
  });

  it('drops a failed Electron-picked image token instead of turning it into a document chip', async () => {
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(true);
    electronHostMocks.selectElectronUserAttachments.mockResolvedValueOnce([{
      token: 'b'.repeat(43),
      name: 'broken.png',
      mediaType: 'image/png',
      expiresAt: FUTURE_ATTACHMENT_EXPIRY,
    }]);
    electronHostMocks.readElectronUserAttachment.mockRejectedValueOnce(new Error('bytes unavailable'));
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText(getI18n().chat.addAttachment));
    await waitFor(() => expect(electronHostMocks.readElectronUserAttachment).toHaveBeenCalledWith({ token: 'b'.repeat(43) }));
    expect(screen.queryByText('broken.png')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'send text only' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toBeUndefined();
    expect(onSend.mock.calls[0][3]).toEqual(expect.any(Function));
  });











});

describe('ChatInput async attachment admission ownership', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    vi.clearAllMocks();
    vi.mocked(readFile).mockReset();
    electronHostMocks.hasElectronCommandHost.mockReturnValue(false);
    electronHostMocks.hasElectronUserAttachmentAuthorizeHost.mockReturnValue(false);
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(false);
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
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    useToastStore.setState(useToastStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it('lands file-tree image admission on the conversation active when admission started', async () => {
    const a = useChatStore.getState().createConversation();
    const b = useChatStore.getState().createConversation(undefined, { skipActivate: true });
    const read = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(readFile).mockReturnValueOnce(read.promise);
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    act(() => {
      useChatStore.getState().addPendingAttachment({
        path: '/workspace/late.png',
        draftKey: getComposerDraftKey(a),
        readScope: 'workspace',
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('/workspace/late.png'));
    await act(async () => {
      await useChatStore.getState().switchConversation(b);
    });

    await act(async () => {
      read.resolve(ONE_BY_ONE_PNG);
      await read.promise;
      await Promise.resolve();
    });

    expect(screen.queryByTitle(getI18n().chat.clickToViewFull)).not.toBeInTheDocument();
    await act(async () => {
      await useChatStore.getState().switchConversation(a);
    });
    expect(screen.getByTitle(getI18n().chat.clickToViewFull)).toBeInTheDocument();
  });

  it('merges a late image admission through the canonical draft after the originating composer remounts', async () => {
    const conversationId = useChatStore.getState().createConversation();
    const draftKey = getComposerDraftKey(conversationId);
    const read = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(readFile).mockReturnValueOnce(read.promise);
    const first = render(<ChatInput variant="chat" onSend={vi.fn()} />);

    act(() => {
      useChatStore.getState().addPendingAttachment({
        path: '/workspace/late.png',
        draftKey,
        readScope: 'workspace',
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('/workspace/late.png'));
    first.unmount();

    writeComposerDraft(draftKey, {
      text: 'new text after remount',
      images: [],
      files: [{
        id: 'existing-pdf',
        token: 'p'.repeat(43),
        name: 'already-attached.pdf',
        expiresAt: FUTURE_ATTACHMENT_EXPIRY,
      }],
      references: [],
      selectedSkill: null,
      selectedAgent: null,
    });
    render(<ChatInput variant="chat" onSend={vi.fn()} />);

    await act(async () => {
      read.resolve(ONE_BY_ONE_PNG);
      await read.promise;
      await Promise.resolve();
    });

    expect(readComposerDraft(draftKey)).toMatchObject({
      text: 'new text after remount',
      files: [expect.objectContaining({ token: 'p'.repeat(43), name: 'already-attached.pdf' })],
      images: [expect.objectContaining({ mediaType: 'image/png' })],
    });
  });

  it('gates send while file-tree attachment admission is pending', async () => {
    const conversationId = useChatStore.getState().createConversation();
    const read = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(readFile).mockReturnValueOnce(read.promise);
    const onSend = vi.fn();
    render(<ChatInput variant="chat" onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'summarize' } });
    act(() => {
      useChatStore.getState().addPendingAttachment({
        path: '/workspace/late.png',
        draftKey: getComposerDraftKey(conversationId),
        readScope: 'workspace',
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('/workspace/late.png'));
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'info' })]),
    );

    await act(async () => {
      read.resolve(ONE_BY_ONE_PNG);
      await read.promise;
      await Promise.resolve();
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toEqual([
      expect.objectContaining({ mediaType: 'image/png' }),
    ]);
  });

  it('keeps file-tree admission owned by the draft across unmount and remount', async () => {
    const conversationId = useChatStore.getState().createConversation();
    const read = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(readFile).mockReturnValueOnce(read.promise);
    const onSend = vi.fn();
    const rendered = render(<ChatInput variant="chat" onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'summarize image' } });
    act(() => {
      useChatStore.getState().addPendingAttachment({
        path: '/workspace/remount.png',
        draftKey: getComposerDraftKey(conversationId),
        readScope: 'workspace',
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('/workspace/remount.png'));
    rendered.unmount();

    render(<ChatInput variant="chat" onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(ONE_BY_ONE_PNG);
      await read.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTitle(getI18n().chat.clickToViewFull)).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][1]).toEqual([
      expect.objectContaining({ mediaType: 'image/png' }),
    ]);
  });

  it('keeps the pending-send lock for a draft across unmount and remount', async () => {
    const conversationId = useChatStore.getState().createConversation();
    const send = deferred<boolean | void>();
    const onSend = vi.fn(() => send.promise);
    const rendered = render(<ChatInput variant="chat" onSend={onSend} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    rendered.unmount();

    render(<ChatInput variant="chat" onSend={onSend} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    // The lock survives the remount: no concurrent dispatch. The blocked
    // attempt is staged for the live dispatcher instead of dropped.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(getQueuedInputs(conversationId).map((entry) => entry.text)).toEqual(['second']);

    await act(async () => {
      send.resolve(true);
      await send.promise;
    });
    clearInputQueue(conversationId);
  });


  it('shows a toast when async picker admission fails', async () => {
    electronHostMocks.hasElectronUserAttachmentSelectHost.mockReturnValue(true);
    electronHostMocks.selectElectronUserAttachments.mockRejectedValueOnce(new Error('dialog unavailable'));
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(getI18n().chat.addAttachment));
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'error' })]),
    ));
  });
});

describe('ChatInput inline agent selection', () => {
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
    useDiscoveryStore.setState({
      skills: [],
      agents: [{ name: 'publisher', description: 'Draft and edit public posts' }],
      isLoading: false,
    });
    useSettingsStore.setState({
      composerEnterBehavior: 'enter',
      disabledAgents: [],
      disabledSkills: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  });

  it('selects an agent after an existing draft without discarding the draft', () => {
    const onSend = vi.fn();
    render(<ChatInput variant="welcome" onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '请帮我优化这段文字@' } });

    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe('请帮我优化这段文字');
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('@publisher 请帮我优化这段文字', undefined, null, expect.any(Function));
  });

  it('gives the suggestion listbox a localized accessible name', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@pub' } });

    expect(screen.getByRole('listbox')).toHaveAccessibleName('Agent and skill suggestions');
    expect(screen.getByRole('option', { name: /publisher/ })).toBeTruthy();
  });

  it('selecting a partial inline agent mention preserves CJK prose after the caret', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    const caret = '请@pub'.length;
    fireEvent.change(textarea, { target: { value: '请@pub润色' } });
    textarea.setSelectionRange(caret, caret);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe('请润色');
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it('selecting a partial caret inside a fully typed inline agent name removes the full candidate', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    const caret = 'Ask @pub'.length;
    fireEvent.change(textarea, { target: { value: 'Ask @publisher' } });
    textarea.setSelectionRange(caret, caret);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe('Ask ');
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });

  it('keeps a task body typed after a partial leading agent command', () => {
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@pub 保留这段任务' } });
    fireEvent.click(screen.getByRole('option', { name: /publisher/ }));

    expect(textarea.value).toBe(' 保留这段任务');
    expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
  });
});

describe('mergeComposerAppend — window.sendPrompt draft merge (C1)', () => {
  it('appends with a newline separator when the draft is non-empty', () => {
    expect(mergeComposerAppend('user was typing', 'widget follow-up')).toBe('user was typing\nwidget follow-up');
  });

  it('uses the addition verbatim when the draft is empty', () => {
    expect(mergeComposerAppend('', 'widget follow-up')).toBe('widget follow-up');
  });

  it('treats a whitespace-only draft as empty (no leading blank line)', () => {
    expect(mergeComposerAppend('   \n  ', 'widget follow-up')).toBe('widget follow-up');
  });

  it('never clobbers the existing draft — the original text is preserved as a prefix', () => {
    const prev = 'important draft I do not want to lose';
    expect(mergeComposerAppend(prev, 'x')).toContain(prev);
  });
});

describe('mergeFileAttachments', () => {
  it('keeps same-name PDFs when their token or path identities differ', () => {
    const merged = mergeFileAttachments(
      [{ id: 'token-a', token: 'token-a'.repeat(6), name: 'plan.pdf' }],
      [
        { id: 'token-b', token: 'token-b'.repeat(6), name: 'plan.pdf' },
        { id: 'path-a', path: '/workspace/a/plan.pdf', name: 'plan.pdf' },
        { id: 'path-b', path: '/workspace/b/plan.pdf', name: 'plan.pdf' },
      ],
    );

    expect(merged.files.map((file) => file.id)).toEqual(['token-a', 'token-b', 'path-a', 'path-b']);
    expect(merged.capped).toBe(false);
  });

  it('deduplicates the same token or same path regardless of basename', () => {
    const merged = mergeFileAttachments(
      [
        { id: 'token-a', token: 'same-token'.repeat(4), name: 'first.pdf' },
        { id: 'path-a', path: '/workspace/a/first.pdf', name: 'first.pdf' },
      ],
      [
        { id: 'token-b', token: 'same-token'.repeat(4), name: 'renamed.pdf' },
        { id: 'path-b', path: '/workspace/a/first.pdf', name: 'copy.pdf' },
      ],
    );

    expect(merged.files.map((file) => file.id)).toEqual(['token-a', 'path-a']);
    expect(merged.capped).toBe(false);
  });

});

const mkDomElement = (overrides: Partial<BrowserElementPayload> = {}) =>
  createDomElementReference({
    tagName: 'DIV',
    id: 'hero',
    classList: ['card'],
    selector: 'div#hero.card',
    outerHTML: '<div id="hero" class="card">same structure</div>',
    text: 'same structure',
    computedStyle: {},
    rect: { x: 0, y: 0, width: 10, height: 10 },
    pageUrl: '/w/index.html',
    pageTitle: 'demo',
    ...overrides,
  });

const mkDocSelection = (text: string, comment?: string) =>
  createDocReference({ path: '/w/doc.md', name: 'doc.md', docType: 'markdown', text, comment });

describe('referenceDedupeKey', () => {
  it('keys dom-element references by their unique id, not by content', () => {
    // Two structurally-identical picks (same outerHTML/page) are deliberate
    // repeat selections and must produce DIFFERENT keys so both survive the
    // dedup pass in the pendingReferences drain effect.
    const a = mkDomElement();
    const b = mkDomElement(); // same payload -> same outerHTML/page, different id
    expect(a.id).not.toBe(b.id);
    expect(referenceDedupeKey(a)).not.toBe(referenceDedupeKey(b));
  });

  it('produces a stable key for the same reference object (guards the once-drain double-add case)', () => {
    const a = mkDomElement();
    expect(referenceDedupeKey(a)).toBe(referenceDedupeKey(a));
  });

  it('keys doc-selection references by path+text+comment, unchanged behavior', () => {
    const a = mkDocSelection('段A', '优化');
    const b = mkDocSelection('段A', '优化');
    // Same content -> same key (doc-selection still dedupes by content).
    expect(referenceDedupeKey(a)).toBe(referenceDedupeKey(b));
    const c = mkDocSelection('段B', '优化');
    expect(referenceDedupeKey(a)).not.toBe(referenceDedupeKey(c));
  });
});

describe('referenceChipLabel', () => {
  it('shows the readable source.name for dom-element, not raw outerHTML', () => {
    const r = mkDomElement({ outerHTML: '<div id="hero" class="card"><span>lots of nested tag soup</span></div>' });
    expect(referenceChipLabel(r)).toBe('div#hero.card');
    expect(referenceChipLabel(r)).not.toContain('<div');
  });

  it('keeps showing the quoted selected text for doc-selection (unchanged)', () => {
    const r = mkDocSelection('本文档用于定义订单…');
    expect(referenceChipLabel(r)).toBe('本文档用于定义订单…');
  });
});
