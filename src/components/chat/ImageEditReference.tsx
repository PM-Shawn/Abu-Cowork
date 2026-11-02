import { Pressable } from '@/components/ds/pressable';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { useMediaFile } from '@/hooks/useMediaFile';
import { useI18n } from '@/i18n';
import { getBaseName } from '@/utils/pathUtils';
import { usePreviewStore } from '@/stores/previewStore';
import { useImageEditStore, type ImageEditEntry } from '@/stores/imageEditStore';
import { useToastStore } from '@/stores/toastStore';

export function ImageEditReference({ entry }: { entry: ImageEditEntry }) {
  const { t } = useI18n();
  const source = useMediaFile(entry.draft.conversationId, entry.draft.source.fileRef.originalPath, 0, entry.draft.source.fileRef);
  const labels = [
    ...(entry.draft.comments.some(item => item.text.trim()) ? [t.media.comments] : []),
    ...(entry.draft.markup.length ? [t.media.markup] : []),
    ...(entry.draft.region.length ? [t.media.region] : []),
  ];
  return <div className="mx-4 mt-3 flex items-center gap-2 rounded-control bg-fill p-2" data-testid="image-edit-reference">
    <Pressable className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => usePreviewStore.getState().openPreview(entry.originalPath)}>
      {source?.grant && <img src={source.grant.url} alt="" className="h-10 w-10 shrink-0 rounded-control object-contain" />}
      <span className="min-w-0">
        <span className="block truncate text-ui-sm text-label">{t.media.editImage} · {getBaseName(entry.originalPath)}</span>
        {labels.length > 0 && <span className="block text-caption text-label-secondary">{labels.join(' · ')}</span>}
      </span>
    </Pressable>
    <IconButton icon={AppIcons.close} label={t.common.cancel} size="sm" onClick={() => void useImageEditStore.getState().cancel(entry.composerKey).then(undefined, error => {
      useToastStore.getState().addToast({ type: 'error', title: t.media.editUnavailable, message: String(error) });
    })} />
  </div>;
}
