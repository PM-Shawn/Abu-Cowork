// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChatInput, { mergeComposerAppend, referenceDedupeKey, referenceChipLabel } from './ChatInput';
import { createDocReference, createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';
import { useChatStore } from '@/stores/chatStore';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import type { EnterpriseBinding } from '@/core/enterprise/types';

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
      pendingAttachmentPaths: [],
    });
  });

  afterEach(() => {
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
