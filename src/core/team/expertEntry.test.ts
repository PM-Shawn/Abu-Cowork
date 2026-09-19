// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { prepareExpertEntry } from './expertEntry';
import { useChatStore } from '@/stores/chatStore';
import { clearAllComposerDrafts, readComposerDraft, writeComposerDraft, WELCOME_COMPOSER_DRAFT_KEY as key } from '@/stores/composerDraftStore';
const contact = { identity: { key: 'agent:role:analyst', kind: 'agent' as const, name: 'Analyst', agentName: 'analyst' }, introduction: 'Who is this for?' };
beforeEach(() => {
  clearAllComposerDrafts();
  useChatStore.setState({ conversations: {}, conversationIndex: {}, expertContactReceipts: {}, pendingExpertContact: null, pendingAttachmentRequests: [], pendingReferences: [] });
});
describe('expert detail entry', () => {
  it('shows first-contact greeting without creating a conversation, and skips confirmed identities', () => {
    prepareExpertEntry(contact);
    expect(useChatStore.getState().pendingExpertContact).toEqual(contact);
    expect(readComposerDraft(key).text).toBe('');
    prepareExpertEntry(contact);
    expect(useChatStore.getState().pendingExpertContact).toEqual(contact);
    expect(useChatStore.getState().conversationIndex).toEqual({});
    useChatStore.setState({ expertContactReceipts: { [contact.identity.key]: { conversationId: 'old', confirmed: true } } });
    prepareExpertEntry(contact);
    expect(useChatStore.getState().pendingExpertContact).toBeNull();
  });
  it('preserves a real draft and attachments while switching to the requested expert', () => {
    writeComposerDraft(key, { ...readComposerDraft(key), text: 'Compare these', files: [{ id: 'f', name: 'report.csv', path: '/report.csv' }], selectedAgent: { name: 'old', description: '' } });
    prepareExpertEntry(contact);
    expect(useChatStore.getState().pendingInput).toBeNull();
    expect(useChatStore.getState().pendingExpertContact).toBeNull();
    expect(readComposerDraft(key)).toMatchObject({ text: 'Compare these', files: [{ name: 'report.csv' }], selectedAgent: { name: 'analyst' } });
  });
  it('prefills a recommended task without sending, and attachment-only drafts also skip greeting', () => {
    prepareExpertEntry(contact, 'Review my plan');
    expect(useChatStore.getState().pendingExpertContact).toBeNull();
    expect(useChatStore.getState().conversationIndex).toEqual({});
    writeComposerDraft(key, { ...readComposerDraft(key), text: '', images: [{ id: 'i', data: 'png', mediaType: 'image/png' }] });
    prepareExpertEntry(contact);
    expect(useChatStore.getState().pendingExpertContact).toBeNull();
    prepareExpertEntry({ identity: { key: 'team:t1', kind: 'team', name: 'Team' }, introduction: 'Hello' });
    expect(readComposerDraft(key).selectedAgent).toBeNull();
    expect(useChatStore.getState().pendingTeamId).toBe('t1');
  });
  // The composer chip draws the expert's avatar, so the entry path has to hand
  // it the identity's avatar — otherwise the greeting bubble shows the real
  // icon while the chip below it falls back to the default mark.
  it('carries the expert avatar into the composer chip draft, and leaves team entries without one', () => {
    prepareExpertEntry({ ...contact, identity: { ...contact.identity, avatar: 'icon:code/blue' } });
    expect(readComposerDraft(key).selectedAgent).toMatchObject({ name: 'analyst', avatar: 'icon:code/blue' });

    // An expert with no avatar of its own leaves the field unset (default mark).
    prepareExpertEntry(contact);
    expect(readComposerDraft(key).selectedAgent?.avatar).toBeUndefined();

    // A team entry pins the team instead of selecting an agent — no chip avatar.
    prepareExpertEntry({ identity: { key: 'team:t2', kind: 'team', name: 'Team', avatar: '\u{1F465}' }, introduction: 'Hello' });
    expect(readComposerDraft(key).selectedAgent).toBeNull();
  });
  it('adds a recommended question to the existing welcome draft', () => {
    writeComposerDraft(key, { ...readComposerDraft(key), text: 'Original task' });
    prepareExpertEntry(contact, 'Recommended question');
    expect(readComposerDraft(key).text).toBe('Original task\nRecommended question');
  });
});
