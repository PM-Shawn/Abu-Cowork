import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Pressable } from '@/components/ds/pressable';
import { Slider } from '@/components/ds/slider';
import { Spinner } from '@/components/ds/spinner';
import { InlineMessage } from '@/components/ds/inline-message';
import { AppIcons } from '@/components/ds/icons';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { findImageEditEntry, useImageEditStore } from '@/stores/imageEditStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode } from '@/stores/composerDraftStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useMediaFile } from '@/hooks/useMediaFile';
import { useI18n } from '@/i18n';
import { imageVersions, imageVersionKey } from '@/core/media/imageVersions';
import type { MediaFileRef } from '@/types/media';
import { getBaseName } from '@/utils/pathUtils';
import ImagePreview from './ImagePreview';

const EMPTY_MESSAGES: never[] = [];

function VersionThumbnail({ conversationId, file, selected, onSelect }: { conversationId: string; file: MediaFileRef; selected: boolean; onSelect: () => void }) {
  const media = useMediaFile(conversationId, file.originalPath, 0, file);
  return <Pressable aria-label={getBaseName(file.originalPath)} aria-pressed={selected} onClick={onSelect}
    className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-control border border-control-border aria-pressed:border-emphasis">
    {media?.grant && <img src={media.grant.url} alt="" className="h-full w-full object-contain" />}
  </Pressable>;
}

export default function MediaImagePreview({ conversationId, fileRef, tabId }: { conversationId: string; fileRef: MediaFileRef; tabId: string }) {
  const { t } = useI18n();
  const messages = useChatStore(state => state.conversations[conversationId]?.messages ?? EMPTY_MESSAGES);
  const history = useMemo(() => imageVersions(messages, fileRef), [messages, fileRef]);
  const scope = useEnterpriseStore(state => getComposerDraftScopeForEnterpriseMode(state.mode));
  const composerKey = getComposerDraftKey(conversationId, scope);
  const entry = useImageEditStore(state => findImageEditEntry(state, composerKey, fileRef.originalPath, fileRef.captureId));
  const selected = fileRef.captureId ? fileRef : entry?.draft.source.fileRef ?? fileRef;
  const media = useMediaFile(conversationId, selected.originalPath, 0, selected);
  const versionKey = imageVersionKey(fileRef);
  const [shown, setShown] = useState<{ key: string; url: string }>();
  useEffect(() => {
    if (media?.grant) setShown({ key: versionKey, url: media.grant.url });
  }, [media?.grant, versionKey]);
  const sourceUrl = media?.grant?.url ?? (shown?.key === versionKey ? shown.url : undefined);
  const parent = useMediaFile(history.parent ? conversationId : '', history.parent?.originalPath ?? '', 0, history.parent);
  const [comparing, setComparing] = useState(false);
  const [amount, setAmount] = useState(50);
  const [showAll, setShowAll] = useState(false);
  const currentIndex = Math.max(0, history.versions.findIndex(file => imageVersionKey(file) === imageVersionKey(fileRef)
    || (!fileRef.captureId && file.originalPath === fileRef.originalPath)));
  const select = (file: MediaFileRef) => { setComparing(false); usePreviewStore.getState().selectImageVersion(tabId, file); };
  return <div className="flex h-full min-h-0 flex-col bg-code">
    <div className="relative min-h-0 flex-1">
      {media?.error ? <div className="p-4"><InlineMessage tone="warning">{t.media.editUnavailable}</InlineMessage></div>
        : !sourceUrl ? <div className="flex h-full items-center justify-center"><Spinner label={t.common.loading} /></div>
        : comparing && parent?.grant ? <div className="flex h-full min-h-0 flex-col p-4">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <img src={sourceUrl} alt={t.media.newResult} className="absolute inset-0 h-full w-full object-contain" />
            <img src={parent.grant.url} alt={t.media.originalImage} className="absolute inset-0 h-full w-full bg-code object-contain" style={{ clipPath: `inset(0 ${100 - amount}% 0 0)` }} />
          </div>
          <Slider label={t.media.compareOriginal} min={0} max={100} step={1} value={amount} onValueChange={setAmount} />
        </div>
        : <ImagePreview key={fileRef.originalPath} src={sourceUrl} alt={getBaseName(fileRef.originalPath)} conversationId={conversationId} filePath={fileRef.originalPath} fileRef={selected} />}
    </div>
    {(history.parent || history.versions.length > 1) && <div className="flex flex-col items-center gap-2 border-t border-separator bg-surface p-2">
      {history.parent && <div className="flex gap-2">
        <Button variant="plain" size="sm" aria-pressed={comparing} onClick={() => setComparing(value => !value)}>{t.media.compareOriginal}</Button>
        <Button variant="plain" size="sm" onClick={() => select(history.parent!)}>{t.media.originalImage}</Button>
      </div>}
      {history.versions.length > 1 && <div className="flex max-w-full items-center gap-2 overflow-auto">
        <IconButton size="sm" icon={AppIcons.previous} label={t.media.previousImage} disabled={currentIndex === 0} onClick={() => select(history.versions[currentIndex - 1])} />
        {(showAll ? history.versions : history.versions.slice(Math.max(0, currentIndex - 3), Math.max(4, currentIndex + 1))).map(file => <VersionThumbnail key={imageVersionKey(file)} conversationId={conversationId} file={file} selected={file === history.versions[currentIndex]} onSelect={() => select(file)} />)}
        <IconButton size="sm" icon={AppIcons.next} label={t.media.nextImage} disabled={currentIndex === history.versions.length - 1} onClick={() => select(history.versions[currentIndex + 1])} />
        {history.versions.length > 4 && <Button size="sm" variant="plain" onClick={() => setShowAll(value => !value)}>{showAll ? t.media.collapseImages : t.media.allImages}</Button>}
      </div>}
    </div>}
  </div>;
}
