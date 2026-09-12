import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useChatStore } from '@/stores/chatStore';
import type { ExpertContact } from '@/types/expertContact';

/** A detail entry owns the identity; an existing task draft keeps its content. */
export function prepareExpertEntry(contact: ExpertContact, prompt?: string): void {
  const chat = useChatStore.getState();
  const key = getComposerDraftKey(null, getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode));
  const draft = readComposerDraft(key);
  const task = prompt ?? draft.text;
  const hasTask = !!task.trim() || draft.images.length > 0 || draft.files.length > 0
    || draft.references.length > 0 || chat.pendingReferences.length > 0
    || chat.pendingAttachmentRequests.some((request) => request.draftKey === key);
  const agent = contact.identity.agentName;
  writeComposerDraft(key, { ...draft, text: task, selectedSkill: null,
    selectedAgent: agent ? { name: agent, description: '' } : null });
  // Route setters invalidate any old greeting. Install the new snapshot last.
  chat.startNewConversation();
  chat.setPendingTeamId(contact.identity.kind === 'team' ? contact.identity.key.slice('team:'.length) : undefined);
  chat.setPendingAgent(agent ?? null);
  chat.setPendingInput(task);
  if (!hasTask && !chat.expertContactReceipts[contact.identity.key]?.confirmed) chat.setPendingExpertContact(contact);
}
