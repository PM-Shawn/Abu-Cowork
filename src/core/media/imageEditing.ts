import { invokeElectronMedia } from '@/utils/electronHost';
import type { ImageEditAttachment, ImageEditRequest, ImageEditTool, MediaFileRef } from '@/types/media';
import { useChatStore } from '@/stores/chatStore';
import { findImageEditEntry, useImageEditStore } from '@/stores/imageEditStore';
import { readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';

export function restoreImageEditing(request: ImageEditRequest, composerKey: string, scope: string) {
  const source = request.attachmentRefs.find(attachment => attachment.kind === 'source');
  if (!source) throw new Error('Image request source is unavailable');
  const key = `${composerKey}\0${source.fileRef.originalPath}\0${request.id}`;
  const store = useImageEditStore.getState();
  const activeKey = store.active[composerKey];
  if (activeKey && activeKey !== key) return store.entries[activeKey].originalPath;
  if (activeKey) store.setPrompt(activeKey, readComposerDraft(composerKey).text);
  const existing = useImageEditStore.getState().entries[key];
  const entry = existing ?? { key, composerKey, originalPath: source.fileRef.originalPath, history: { past: [], future: [] }, draft: {
    scope, conversationId: request.conversationId, sourceArtifactId: request.sourceArtifactId,
    sourceCaptureId: request.sourceCaptureId, sourceDigest: request.sourceDigest, source,
    prompt: request.prompt, comments: request.comments, markup: request.markup, region: request.region, activeTool: 'prompt' as const,
  } };
  store.activate(entry);
  writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: entry.draft.prompt });
  return source.fileRef.originalPath;
}

export async function activateImageEditing({ composerKey, conversationId, scope, filePath, fileRef, tool = 'prompt' }: {
  composerKey: string;
  conversationId: string;
  scope: string;
  filePath: string;
  fileRef?: MediaFileRef;
  tool?: ImageEditTool;
}) {
  const activation = Symbol();
  useImageEditStore.setState(state => ({ pending: { ...state.pending, [composerKey]: activation } }));
  const existing = findImageEditEntry(useImageEditStore.getState(), composerKey, filePath, fileRef?.captureId);
  const key = existing?.key ?? `${composerKey}\0${filePath}${fileRef?.captureId ? `\0${fileRef.captureId}` : ''}`;
  const source = existing?.draft.source ?? await invokeElectronMedia<ImageEditAttachment>('capture', { conversationId, fileRef: fileRef ?? { originalPath: filePath } });
  if (useImageEditStore.getState().pending[composerKey] !== activation) {
    if (!existing) await invokeElectronMedia<void>('release-capture', { conversationId, fileRef: source.fileRef });
    return false;
  }
  const store = useImageEditStore.getState();
  const composer = readComposerDraft(composerKey);
  const previousKey = store.active[composerKey];
  if (previousKey && previousKey !== key) store.setPrompt(previousKey, composer.text);
  const artifact = useChatStore.getState().conversations[conversationId]?.messages.flatMap(message => message.mediaArtifacts ?? []).find(item => item.fileRef.originalPath === filePath);
  const entry = existing ? { ...existing, draft: { ...existing.draft, prompt: previousKey === key ? composer.text : existing.draft.prompt, activeTool: tool } } : {
    key, composerKey, originalPath: filePath, history: { past: [], future: [] },
    draft: {
      scope, conversationId, sourceArtifactId: artifact?.id ?? `capture:${source.fileRef.captureId}`,
      sourceCaptureId: source.fileRef.captureId!, sourceDigest: source.fileRef.contentDigest!, source,
      activeTool: tool, prompt: previousKey ? '' : composer.text, comments: [], markup: [], region: [],
    },
  };
  store.activate(entry);
  writeComposerDraft(composerKey, { ...composer, text: entry.draft.prompt });
  return true;
}
