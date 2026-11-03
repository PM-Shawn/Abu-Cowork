import { Button } from '@/components/ds/button';
import { Spinner } from '@/components/ds/spinner';
import { useI18n } from '@/i18n';
import { retryImageSave, useMediaJobStore } from '@/core/media/mediaJobs';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode } from '@/stores/composerDraftStore';
import { restoreImageEditing } from '@/core/media/imageEditing';
import type { ImageEditRequest } from '@/types/media';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';

export function ImageEditStatus({ request }: { request: ImageEditRequest }) {
  const { t } = useI18n();
  const record = useMediaJobStore(state => state.records[request.id]);
  const state = record?.job.generationState ?? 'prepared';
  if (state === 'completed') return null;
  const failed = ['failed', 'unknown', 'save_failed', 'cancelled'].includes(state);
  const label = state === 'unknown' ? t.media.resultUnknown : state === 'save_failed' ? t.media.saveFailed
    : failed ? t.media.editFailed : record?.job.waitState === 'detached' ? t.media.stoppedWaiting : t.media.editing;
  const restore = () => {
    const scope = getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode);
    const composerKey = getComposerDraftKey(request.conversationId, scope);
    usePreviewStore.getState().openPreview(restoreImageEditing(request, composerKey, scope));
  };
  return <div className="flex flex-wrap items-center gap-2 text-ui-sm text-label-secondary" role="status">
    {!failed && record?.job.waitState !== 'detached' && <Spinner label={label} />}
    <span>{label}</span>
    {state === 'save_failed' && <Button variant="plain" size="sm" onClick={() => void retryImageSave(request.conversationId, request.id).then(undefined, error => {
      useToastStore.getState().addToast({ type: 'error', title: t.media.saveFailed, message: String(error) });
    })}>{t.common.retry}</Button>}
    {failed && <Button variant="plain" size="sm" onClick={restore}>{t.media.editInstructions}</Button>}
  </div>;
}
