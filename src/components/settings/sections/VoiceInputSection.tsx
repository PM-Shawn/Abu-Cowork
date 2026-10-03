import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Mic, Trash2, X } from 'lucide-react';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useToastStore } from '@/stores/toastStore';
import { ensureSpeechStatus, useSpeechStore } from '@/stores/speechStore';
import { useVoiceInputStore } from '@/stores/voiceInputStore';
import type { SpeechDownloadSource, SpeechLanguage } from '@/core/speech/speechBridge';
import { describeDownloadError, speechLanguageOptions } from '@/core/speech/voiceInputText';
import { getMicrophoneStatus, openMicrophoneSettings, type MicrophoneStatus } from '@/core/speech/microphoneBridge';
import { formatFileSize } from '@/utils/formatFileSize';
import { isMacOS, isWindows } from '@/utils/platform';

const SETTINGS_CONTROL_WIDTH = 'w-40 shrink-0';
const ROW = 'p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]';

type VoiceText = TranslationDict['voiceInput'];

function micStatusLabel(v: VoiceText, status: MicrophoneStatus): string {
  if (status === 'granted') return v.micGranted;
  if (status === 'denied' || status === 'restricted') return v.micDenied;
  if (status === 'not-determined') return v.micNotDetermined;
  return v.micUnknown;
}

export default function VoiceInputSection() {
  const { t } = useI18n();
  const v = t.voiceInput;
  const enabled = useVoiceInputStore((s) => s.enabled);
  const language = useVoiceInputStore((s) => s.language);
  const setEnabled = useVoiceInputStore((s) => s.setEnabled);
  const setLanguage = useVoiceInputStore((s) => s.setLanguage);
  const status = useSpeechStore((s) => s.status);
  const unavailable = useSpeechStore((s) => s.unavailable);
  const downloadModel = useSpeechStore((s) => s.downloadModel);
  const cancelDownload = useSpeechStore((s) => s.cancelDownload);
  const deleteModel = useSpeechStore((s) => s.deleteModel);
  const [source, setSource] = useState<SpeechDownloadSource>('auto');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mic, setMic] = useState<MicrophoneStatus>('unknown');

  useEffect(() => { ensureSpeechStatus(); }, []);

  const refreshMic = useCallback(() => {
    getMicrophoneStatus().then(setMic, () => setMic('unknown'));
  }, []);
  useEffect(() => {
    refreshMic();
    // Returning from System Settings: re-read the OS permission.
    window.addEventListener('focus', refreshMic);
    return () => window.removeEventListener('focus', refreshMic);
  }, [refreshMic]);

  const model = status?.model;
  const sizeText = formatFileSize(model?.totalBytes ?? 241_357_257);
  const showMicSettings = (isMacOS() || isWindows()) && (mic === 'denied' || mic === 'restricted');

  const sourceOptions = [
    { value: 'auto', label: v.sourceAuto },
    { value: 'hf-mirror', label: v.sourceMirror },
    { value: 'huggingface', label: v.sourceHuggingface },
  ];

  const handleDelete = async () => {
    setConfirmDelete(false);
    await deleteModel();
    useToastStore.getState().addToast({ type: 'success', title: v.deleted });
  };

  const renderModelBody = () => {
    if (unavailable) return <p className="text-minor text-[var(--abu-text-muted)]">{v.unavailable}</p>;
    if (!status || !model || model.state === 'checking') {
      return (
        <p className="flex items-center gap-2 text-minor text-[var(--abu-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {v.modelChecking}
        </p>
      );
    }
    if (!status.runtimeAvailable) {
      return <p className="text-minor text-[var(--abu-danger)]">{v.runtimeMissing}</p>;
    }
    if (model.state === 'downloading') {
      const progress = model.download;
      const percent = progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0;
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-minor text-[var(--abu-text-secondary)] truncate">
              {progress
                ? format(v.modelDownloading, { file: progress.file, index: progress.fileIndex + 1, count: progress.fileCount })
                : v.modelChecking}
            </p>
            <Button variant="ghost" size="xs" onClick={() => void cancelDownload()}>
              <X className="h-3 w-3" />
              {v.cancel}
            </Button>
          </div>
          <div
            className="h-1.5 rounded-full bg-[var(--abu-bg-active)] overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div className="h-full bg-[var(--abu-clay)] transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          {progress && (
            <p className="text-caption text-[var(--abu-text-muted)]">
              {format(v.modelProgress, { received: formatFileSize(progress.received), total: formatFileSize(progress.total) })}
            </p>
          )}
        </div>
      );
    }
    if (model.state === 'ready') {
      return (
        <div className="flex items-center justify-between gap-3">
          <p className="text-minor text-[var(--abu-success)]">{v.modelReady}</p>
          <Button variant="ghost" size="xs" className="text-[var(--abu-danger)]" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-3 w-3" />
            {v.deleteModel}
          </Button>
        </div>
      );
    }
    // missing | error
    return (
      <div className="space-y-3">
        {model.state === 'error' && (
          <p className="text-minor text-[var(--abu-danger)]">{describeDownloadError(v, model.error)}</p>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-minor text-[var(--abu-text-muted)]">{v.source}</span>
            <div className={SETTINGS_CONTROL_WIDTH}>
              <Select
                variant="inline"
                value={source}
                options={sourceOptions}
                onChange={(value) => setSource(value as SpeechDownloadSource)}
              />
            </div>
          </div>
          <Button size="sm" onClick={() => void downloadModel(source)}>
            <Download className="h-3.5 w-3.5" />
            {model.state === 'error' ? v.retry : v.download}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <SettingsSectionHeader title={v.title} description={v.description} />

      <div className={`flex items-center justify-between ${ROW}`}>
        <div className="flex-1 mr-4">
          <p className="text-body text-[var(--abu-text-primary)]">{v.enable}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{v.enableDesc}</p>
        </div>
        <Toggle checked={enabled} onChange={() => setEnabled(!enabled)} size="lg" />
      </div>

      <div className={`space-y-3 ${ROW}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-body text-[var(--abu-text-primary)]">{v.modelTitle}</p>
            <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{format(v.modelDesc, { size: sizeText })}</p>
          </div>
          {model && model.state !== 'checking' && (
            <span className="text-caption text-[var(--abu-text-muted)] shrink-0">
              {model.state === 'ready' ? v.modelReady
                : model.state === 'downloading' ? '' : model.state === 'error' ? v.modelError : v.modelMissing}
            </span>
          )}
        </div>
        {renderModelBody()}
      </div>

      <div className={`flex items-center justify-between ${ROW}`}>
        <div className="flex-1 mr-4">
          <p className="text-body text-[var(--abu-text-primary)]">{v.language}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{v.languageDesc}</p>
        </div>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={language}
            options={speechLanguageOptions(v)}
            onChange={(value) => setLanguage(value as SpeechLanguage)}
          />
        </div>
      </div>

      <div className={`flex items-center justify-between ${ROW}`}>
        <div className="flex-1 mr-4">
          <p className="flex items-center gap-2 text-body text-[var(--abu-text-primary)]">
            <Mic className="h-4 w-4" />
            {v.micTitle}
            <span className="text-caption text-[var(--abu-text-muted)]">{micStatusLabel(v, mic)}</span>
          </p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{v.micDesc}</p>
        </div>
        {showMicSettings && (
          <Button variant="outline" size="sm" onClick={() => void openMicrophoneSettings()}>
            {v.openSystemSettings}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={v.deleteModel}
        message={format(v.modelDesc, { size: sizeText })}
        confirmText={v.deleteModel}
        cancelText={v.cancel}
        variant="danger"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
