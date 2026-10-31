import { useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { Button, IconButton } from '@/components/ds/button';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { AppIcons } from '@/components/ds/icons';
import { useMediaFile } from '@/hooks/useMediaFile';
import { useI18n } from '@/i18n';
import { getBaseName } from '@/utils/pathUtils';
import { savePreviewCopy } from '@/components/panel/previewFileActions';
import { openWithDefaultApp } from '@/utils/openWithDefaultApp';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';
import { claimMediaPlayback, releaseMediaPlayback } from '@/core/media/mediaPlayback';
import { invokeElectronMedia } from '@/utils/electronHost';

export default function VideoPreview({ conversationId, filePath, active = true, inline = false }: {
  conversationId: string;
  filePath: string;
  active?: boolean;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const visibleConversationId = useChatStore(state => state.activeConversationId);
  const [revision, setRevision] = useState(0);
  const media = useMediaFile(conversationId, filePath, revision);
  const [failure, setFailure] = useState<{ url: string; code: number }>();
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const fileName = getBaseName(filePath);
  const failed = media?.error || (media?.grant && failure?.url === media.grant.url);
  const failureLabel = media?.error ? t.media.videoReadFailed : failure?.code === 3 ? t.media.videoDecodeFailed
    : failure?.code === 4 ? t.media.videoFormatUnsupported : t.media.videoReadFailed;

  useEffect(() => { if (!active || visibleConversationId !== conversationId) video.current?.pause(); }, [active, visibleConversationId, conversationId]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const hide = () => { if (document.hidden) element.pause(); };
    const exitWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || document.fullscreenElement !== element) return;
      event.preventDefault();
      event.stopPropagation();
      void invokeElectronMedia<void>('wait-fullscreen', {}).then(async () => {
        if (document.fullscreenElement === element) await document.exitFullscreen();
      }).then(undefined, error => useToastStore.getState().addToast({ type: 'error', title: t.media.videoUnavailable, message: String(error) }));
    };
    let wasFullscreen = false;
    const fullscreenChanged = () => {
      const fullscreen = document.fullscreenElement === element;
      if (wasFullscreen && !fullscreen) fullscreenTrigger.current?.focus();
      wasFullscreen = fullscreen;
    };
    document.addEventListener('visibilitychange', hide);
    document.addEventListener('keydown', exitWithEscape, true);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      document.removeEventListener('keydown', exitWithEscape, true);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      releaseMediaPlayback(element);
    };
  }, [media?.grant?.url, t.media.videoUnavailable]);
  const reportError = (error: unknown) => useToastStore.getState().addToast({ type: 'error', title: t.media.videoUnavailable, message: String(error) });
  const enterFullscreen = async () => {
    setFullscreenPending(true);
    try {
      await invokeElectronMedia<void>('wait-fullscreen', {});
      await video.current?.requestFullscreen();
    } finally { setFullscreenPending(false); }
  };

  const saveCopy = async () => {
    const destination = await save({ defaultPath: fileName });
    if (!destination) return;
    await savePreviewCopy({ sourcePath: filePath, destinationPath: destination });
    useToastStore.getState().addToast({ type: 'success', title: t.panel.saveAsDone });
  };

  return (
    <div
      className={cn('group/media relative flex min-w-0 items-center justify-center overflow-hidden rounded-panel bg-surface', inline ? 'w-full max-w-2xl' : 'h-full w-full')}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false); }}
    >
      {failed ? (
        <div className="flex flex-col items-center gap-3 p-6">
          <InlineMessage tone="warning">{failureLabel}</InlineMessage>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRevision(value => value + 1)}>{t.common.retry}</Button>
            <Button variant="secondary" size="sm" onClick={() => void openWithDefaultApp(filePath).then(undefined, reportError)}>{t.media.openInApp}</Button>
          </div>
        </div>
      ) : media?.grant ? (
        <video
          ref={video}
          src={media.grant.url}
          aria-label={fileName}
          controls={pointerInside || focusInside}
          tabIndex={0}
          controlsList="nofullscreen"
          playsInline
          preload="metadata"
          className={cn('block w-full object-contain', inline ? 'max-h-96' : 'h-full')}
          onError={event => setFailure({ url: media.grant!.url, code: event.currentTarget.error?.code ?? 0 })}
          onPlay={event => claimMediaPlayback(event.currentTarget)}
        />
      ) : <div className="flex aspect-video w-full items-center justify-center"><Spinner label={t.common.loading} /></div>}
      {!failed && media?.grant && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2 opacity-0 transition-opacity duration-fast group-hover/media:opacity-100 group-focus-within/media:opacity-100">
          <span className="max-w-3/4 truncate rounded-control bg-surface/90 px-2 py-1 text-caption text-label">{fileName}</span>
          <div className="pointer-events-auto flex gap-1 rounded-control bg-surface/90">
            <IconButton ref={fullscreenTrigger} icon={AppIcons.enlarge} label={t.panel.fullscreen} size="sm" disabled={fullscreenPending} onClick={() => void enterFullscreen().then(undefined, reportError)} />
            <IconButton icon={AppIcons.download} label={t.panel.saveAs} size="sm" onClick={() => void saveCopy().then(undefined, error => useToastStore.getState().addToast({ type: 'error', title: t.panel.saveAsFailed, message: String(error) }))} />
          </div>
        </div>
      )}
    </div>
  );
}
