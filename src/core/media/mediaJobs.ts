import { useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import { invokeElectronMedia } from '@/utils/electronHost';
import { imageEditRequestSchema, mediaArtifactSchema, mediaJobSchema, type MediaJobRecord } from '@/types/media';
import { create } from 'zustand';
import { usePreviewStore } from '@/stores/previewStore';

export const useMediaJobStore = create<{ records: Record<string, MediaJobRecord> }>(() => ({ records: {} }));

export async function discardPreparedImageEdit(conversationId: string, requestId: string): Promise<void> {
  const released = await invokeElectronMedia<string[]>('discard-prepared-edit', { conversationId, requestId });
  usePreviewStore.getState().releaseImageSources(released);
}

export function acceptMediaJobRecord(input: MediaJobRecord): void {
  const record: MediaJobRecord = {
    request: imageEditRequestSchema.parse(input.request),
    job: mediaJobSchema.parse(input.job),
    artifacts: input.artifacts.map(artifact => mediaArtifactSchema.parse(artifact)),
  };
  if (record.job.requestId !== record.request.id || record.job.conversationId !== record.request.conversationId
    || record.job.scope !== record.request.scope) throw new Error('Image job ownership does not match');
  const chat = useChatStore.getState();
  const conversation = chat.conversations[record.request.conversationId];
  if (!conversation) return;
  const message = conversation.messages.find(item => item.id === record.request.messageId && item.role === 'user');
  if (!message?.imageEditRequest) return;
  if (JSON.stringify(imageEditRequestSchema.parse(message.imageEditRequest)) !== JSON.stringify(record.request)) throw new Error('Image request ownership does not match');
  const previous = useMediaJobStore.getState().records[record.request.id];
  if (previous && previous.job.sequence > record.job.sequence) return;
  useMediaJobStore.setState(state => ({ records: { ...state.records, [record.request.id]: record } }));
  if (record.job.generationState !== 'completed') return;
  for (const artifact of record.artifacts) {
    if (artifact.conversationId !== conversation.id || artifact.editRequestId !== record.request.id
      || !record.job.outputArtifactIds.includes(artifact.id)) throw new Error('Image result ownership does not match');
    if (conversation.messages.some(message => message.id === artifact.messageId)) continue;
    chat.addMessage(conversation.id, { id: artifact.messageId, role: 'assistant', content: '', timestamp: Date.now(), mediaArtifacts: [artifact] });
  }
}

export async function detachImageEdits(conversationId: string): Promise<void> {
  const conversation = useChatStore.getState().conversations[conversationId];
  if (!conversation) return;
  await Promise.all(conversation.messages.flatMap(message => message.imageEditRequest ? [
    invokeElectronMedia<MediaJobRecord>('detach-edit', { conversationId, requestId: message.imageEditRequest.id }).then(acceptMediaJobRecord),
  ] : []));
}

export async function retryImageSave(conversationId: string, requestId: string): Promise<void> {
  acceptMediaJobRecord(await invokeElectronMedia<MediaJobRecord>('retry-save', { conversationId, requestId }));
}

export async function refreshMediaJobs(conversationId: string): Promise<void> {
  const conversation = useChatStore.getState().conversations[conversationId];
  if (!conversation) return;
  await Promise.all(conversation.messages.flatMap(message => message.imageEditRequest ? [
    invokeElectronMedia<MediaJobRecord>('get-edit', { conversationId, requestId: message.imageEditRequest.id }).then(acceptMediaJobRecord),
  ] : []));
}

export async function executeImageEdit(conversationId: string, requestId: string): Promise<MediaJobRecord> {
  await waitForConversationPersistence(conversationId);
  const result = await invokeElectronMedia<MediaJobRecord>('execute-edit', { conversationId, requestId });
  acceptMediaJobRecord(result);
  return result;
}
