import { useCallback, useEffect, useRef, useState } from 'react';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Select } from '@/components/ds/select';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Spinner } from '@/components/ds/spinner';
import type { StatusTone } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { ensureSpeechStatus, useSpeechStore } from '@/stores/speechStore';
import { useVoiceInputStore } from '@/stores/voiceInputStore';
import type { SpeechDownloadSource, SpeechLanguage } from '@/core/speech/speechBridge';
import { describeDownloadError, speechLanguageOptions } from '@/core/speech/voiceInputText';
import { getMicrophoneStatus, openMicrophoneSettings, type MicrophoneStatus } from '@/core/speech/microphoneBridge';
import { formatFileSize } from '@/utils/formatFileSize';
import { isMacOS, isWindows } from '@/utils/platform';

type VoiceText = TranslationDict['voiceInput'];

// One line of the model box: what there is on the left, what can be done about it on the right.
const MODEL_LINE = 'flex items-center justify-between gap-6 py-3';

function micStatusLabel(v: VoiceText, status: MicrophoneStatus): string {
  if (status === 'granted') return v.micGranted;
  if (status === 'denied' || status === 'restricted') return v.micDenied;
  if (status === 'not-determined') return v.micNotDetermined;
  return v.micUnknown;
}

function micStatusTone(status: MicrophoneStatus): 'neutral' | StatusTone {
  if (status === 'granted') return 'success';
  if (status === 'denied' || status === 'restricted') return 'warning';
  return 'neutral';
}

export default function VoiceInputSection() {
  const { t } = useI18n();
  const v = t.voiceInput;
  const confirm = useConfirm();
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
  const [mic, setMic] = useState<MicrophoneStatus>('unknown');
  // One delete per question: a second answer while the first delete runs does nothing.
  const deletingRef = useRef(false);

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

  // A download or a delete started from the settings window while it fades out is not what the user asked for.
  const settingsOpen = () => useSettingsStore.getState().systemSettingsOpen;

  const handleDownload = () => {
    if (!settingsOpen()) return;
    void downloadModel(source);
  };

  const handleDelete = async () => {
    const yes = await confirm({
      title: v.deleteModel,
      message: format(v.modelDesc, { size: sizeText }),
      confirmLabel: v.deleteModel,
      tone: 'danger',
    });
    // The model is read again at answer time: it may have gone, or a delete may already be running.
    if (!yes || deletingRef.current || useSpeechStore.getState().status?.model.state !== 'ready') return;
    deletingRef.current = true;
    try {
      await deleteModel();
      useToastStore.getState().addToast({ type: 'success', title: v.deleted });
    } finally {
      deletingRef.current = false;
    }
  };

  const renderModelBody = () => {
    if (unavailable) return <p className="py-3 text-ui-sm text-label-secondary">{v.unavailable}</p>;
    if (!status || !model || model.state === 'checking') {
      return <div className="py-3"><Spinner size="sm" label={v.modelChecking} /></div>;
    }
    if (!status.runtimeAvailable) {
      return <div className="py-3"><InlineMessage tone="danger">{v.runtimeMissing}</InlineMessage></div>;
    }
    if (model.state === 'downloading') {
      const progress = model.download;
      const percent = progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0;
      const progressText = progress
        ? format(v.modelDownloading, { file: progress.file, index: progress.fileIndex + 1, count: progress.fileCount })
        : v.modelChecking;
      return (
        <div className="space-y-2 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-ui-sm text-label-secondary">{progressText}</p>
            <Button variant="plain" size="sm" icon={AppIcons.close} onClick={() => void cancelDownload()}>
              {v.cancel}
            </Button>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-fill"
            role="progressbar"
            aria-label={progressText}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div className="h-full rounded-full bg-emphasis" style={{ width: `${percent}%` }} />
          </div>
          {progress && (
            <p className="text-caption tabular-nums text-label-tertiary">
              {format(v.modelProgress, { received: formatFileSize(progress.received), total: formatFileSize(progress.total) })}
            </p>
          )}
        </div>
      );
    }
    if (model.state === 'ready') {
      return (
        <div className={MODEL_LINE}>
          <Tag tone="success">{v.modelReady}</Tag>
          <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => void handleDelete()}>
            {v.deleteModel}
          </Button>
        </div>
      );
    }
    // missing | error
    return (
      <>
        {model.state === 'error' && (
          <div className="py-3">
            <InlineMessage tone="danger">{describeDownloadError(v, model.error)}</InlineMessage>
          </div>
        )}
        <SettingRow title={v.source}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={v.source}
              value={source}
              options={sourceOptions}
              onValueChange={(value) => setSource(value as SpeechDownloadSource)}
            />
          </div>
        </SettingRow>
        <div className={MODEL_LINE}>
          {model.state === 'error' ? <Tag tone="danger">{v.modelError}</Tag> : <Tag>{v.modelMissing}</Tag>}
          <Button variant="primary" size="sm" icon={AppIcons.download} onClick={handleDownload}>
            {model.state === 'error' ? v.retry : v.download}
          </Button>
        </div>
      </>
    );
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={v.title} description={v.description} />

      <SettingGroup>
        <SettingRow title={v.enable} description={v.enableDesc} htmlFor="setting-voice-enable">
          <Switch id="setting-voice-enable" checked={enabled} onCheckedChange={setEnabled} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={v.modelTitle} description={format(v.modelDesc, { size: sizeText })}>
        {renderModelBody()}
      </SettingGroup>

      <SettingGroup>
        <SettingRow title={v.language} description={v.languageDesc}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={v.language}
              value={language}
              options={speechLanguageOptions(v)}
              onValueChange={(value) => setLanguage(value as SpeechLanguage)}
            />
          </div>
        </SettingRow>
        <SettingRow
          title={(
            <span className="inline-flex items-center gap-2">
              <Icon icon={AppIcons.microphone} size="sm" />
              {v.micTitle}
              <Tag tone={micStatusTone(mic)}>{micStatusLabel(v, mic)}</Tag>
            </span>
          )}
          description={v.micDesc}
        >
          {showMicSettings && (
            <Button variant="secondary" size="sm" onClick={() => void openMicrophoneSettings()}>
              {v.openSystemSettings}
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
