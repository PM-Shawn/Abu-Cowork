import { useState, useCallback, useRef, useEffect } from 'react';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { getDeviceId } from '@/utils/deviceId';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { APP_VERSION } from '@/utils/version';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate, downloadAndInstallUpdate, restartApp, refreshUpdateNotes } from '@/core/updates/checker';
import { getUpdateProgressPresentation } from '@/core/updates/progress';
import { useI18n } from '@/i18n';

type CheckResult = 'idle' | 'just-checked' | 'error';

const TEXT_LINK = 'inline-flex items-center gap-1 rounded-control text-ui-sm text-link hover:underline';


export default function AboutSection() {
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const updateChecking = useSettingsStore((s) => s.updateChecking);
  const updaterUnsupported = useSettingsStore((s) => s.updaterUnsupported);
  const downloadProgress = useSettingsStore((s) => s.updateDownloadProgress);
  const updateInstalling = useSettingsStore((s) => s.updateInstalling);
  const { t, locale } = useI18n();
  const [checkResult, setCheckResult] = useState<CheckResult>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [idCopied, setIdCopied] = useState(false);

  // The release notes are resolved in whatever language was active at check
  // time. When the user switches the UI language, re-pick them for the new
  // locale so a pending update's notes follow the language (skip the first
  // render — nothing to re-pick until the language actually changes).
  const localeInitRef = useRef(true);
  useEffect(() => {
    if (localeInitRef.current) {
      localeInitRef.current = false;
      return;
    }
    void refreshUpdateNotes();
  }, [locale]);

  // While updaterUnsupported is null no check has answered this session, so the
  // caption must not claim anything (see captionState below). Resolve the
  // unknown as soon as the panel opens: a forced silent check answers instantly
  // and offline on unsupported builds, and on official builds it is the same
  // feed query the panel's button would run. Without this, a persisted
  // lastUpdateCheck (<6h) keeps the throttled startup check from ever setting
  // the flag, leaving the caption blank for the whole session.
  useEffect(() => {
    if (useSettingsStore.getState().updaterUnsupported === null) {
      void checkForUpdate(true, { silent: true }).catch(() => {});
    }
  }, []);
  const deviceId = getDeviceId();

  const handleCopyDeviceId = useCallback(() => {
    void navigator.clipboard.writeText(deviceId).then(() => {
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 2000);
    });
  }, [deviceId]);

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      console.error('Failed to open link:', e);
    }
  };

  const handleCheckUpdate = useCallback(async () => {
    setCheckResult('idle');
    try {
      const result = await checkForUpdate(true);
      switch (result.kind) {
        case 'up-to-date':
          setCheckResult('just-checked');
          setTimeout(() => setCheckResult('idle'), 3000);
          break;
        case 'error':
          if (!result.updaterUnsupported) {
            setCheckResult('just-checked');
            setTimeout(() => setCheckResult('idle'), 3000);
          }
          break;
        case 'update':
        case 'disabled':
        case 'throttled':
          break;
      }
    } catch {
      setCheckResult('error');
      setTimeout(() => setCheckResult('idle'), 3000);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    // The settings window stays on the page while it fades out; a key press there starts nothing.
    if (!useSettingsStore.getState().systemSettingsOpen) return;
    setDownloadError(null);
    try {
      await downloadAndInstallUpdate();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRestart = useCallback(async () => {
    if (!useSettingsStore.getState().systemSettingsOpen) return;
    try {
      await restartApp();
    } catch (err) {
      console.error('Failed to restart:', err);
    }
  }, []);

  // What the status caption under the check button may claim, resolved up
  // front so the JSX stays a flat lookup. 'unknown' (updaterUnsupported still
  // null — no check has answered this session) renders NOTHING: absence of a
  // check must never read as "up to date" — a non-official package with the
  // updater silently disabled misled users into thinking no newer version
  // existed (v0.41.0 post-release incident).
  let captionState: 'unsupported' | 'error' | 'unknown' | 'up-to-date' | null = null;
  if (!updateInfo && !updateChecking) {
    if (updaterUnsupported) captionState = 'unsupported';
    else if (checkResult === 'error') captionState = 'error';
    else if (updaterUnsupported === null) captionState = 'unknown';
    else captionState = 'up-to-date';
  }

  const progressPresentation = downloadProgress
    ? getUpdateProgressPresentation(downloadProgress)
    : null;
  const progressStatus = downloadProgress?.phase === 'preparing'
    ? t.updates.preparingDownload
    : downloadProgress?.phase === 'verifying'
      ? t.updates.verifying
      : t.updates.downloading;

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.common.version} description={t.about.versionDescription} />

      {/* Version info */}
      <SettingGroup>
        <SettingRow title={t.updates.currentVersion}>
          <span className="text-ui font-medium text-label">v{APP_VERSION}</span>
        </SettingRow>
        <SettingRow title={t.about.deviceId}>
          <Pressable
            onClick={handleCopyDeviceId}
            className="inline-flex items-center gap-2 rounded-control font-code text-ui-sm text-label-secondary hover:text-label"
            title={deviceId}
          >
            <span>{deviceId.slice(0, 8)}</span>
            <Icon icon={idCopied ? AppIcons.done : AppIcons.copy} size="sm" />
          </Pressable>
        </SettingRow>
      </SettingGroup>

      {/* Update card */}
      {updateInfo && (
        <div className="space-y-3 rounded-panel border border-separator p-4">
          <div className="flex items-center justify-between">
            <span className="text-ui font-medium text-label">{t.updates.newVersionAvailable}</span>
            <span className="font-code text-ui font-medium text-label">v{updateInfo.version}</span>
          </div>
          {(updateInfo.releaseNotes || updateInfo.releaseUrl) && (
            <div className="space-y-2">
              <span className="text-ui-sm font-medium text-label-tertiary">{t.updates.releaseNotes}</span>
              {updateInfo.releaseNotes && updateInfo.releaseNotes.trim().length > 0 ? (
                <div className="space-y-2 text-ui text-label-secondary
                  [&_h3]:mt-2 [&_h3]:text-ui-sm [&_h3]:font-medium [&_h3]:text-label
                  [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5
                  [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5
                  [&_strong]:font-medium [&_strong]:text-label">
                  <ReactMarkdown
                    remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
                    components={{
                      a: ({ href, children }) => (
                        <a
                          href={href ?? '#'}
                          onClick={(e) => {
                            e.preventDefault();
                            if (href) void handleOpenLink(href);
                          }}
                          className="cursor-pointer text-link hover:underline"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {updateInfo.releaseNotes}
                  </ReactMarkdown>
                </div>
              ) : null}
              {updateInfo.releaseUrl && (
                <Pressable onClick={() => void handleOpenLink(updateInfo.releaseUrl)} className={TEXT_LINK}>
                  <Icon icon={AppIcons.openExternal} size="sm" />
                  {t.updates.viewOnGitHub}
                </Pressable>
              )}
            </div>
          )}

          {/* Download progress bar */}
          {downloadProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-ui-sm text-label-secondary">
                <span>{progressStatus}</span>
                {progressPresentation?.percentLabel && (
                  <span className="tabular-nums">{progressPresentation.percentLabel}%</span>
                )}
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-fill"
                role="progressbar"
                aria-label={progressStatus}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPresentation?.percent ?? undefined}
              >
                {progressPresentation?.indeterminate ? (
                  <div className="update-progress-indeterminate h-full rounded-full bg-emphasis" />
                ) : (
                  // Snap to the real value instead of easing behind frequent
                  // updater events. The one-decimal label keeps slow downloads
                  // visibly alive even while the fill advances by tiny amounts.
                  <div
                    className="h-full rounded-full bg-emphasis"
                    style={{ width: `${progressPresentation?.percent ?? 0}%` }}
                  />
                )}
              </div>
            </div>
          )}

          {/* Download error */}
          {downloadError && (
            <InlineMessage
              tone="danger"
              action={<Button variant="plain" size="sm" onClick={handleDownload}>{t.updates.retry}</Button>}
            >
              {t.updates.downloadFailed}
            </InlineMessage>
          )}

          {/* Action buttons: one at a time, so the page never shows two filled buttons. */}
          {updateInstalling ? (
            <div className="flex justify-end">
              <Button variant="primary" icon={AppIcons.restart} onClick={handleRestart}>
                {t.updates.restartToInstall}
              </Button>
            </div>
          ) : !downloadProgress && !downloadError && (
            <div className="flex justify-end">
              <Button variant="primary" icon={AppIcons.download} onClick={handleDownload}>
                {t.updates.downloadUpdate}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Check for updates: the button, and beside it what the check is doing or found. */}
      <div className="flex items-start gap-3">
        <Button
          variant="secondary"
          icon={AppIcons.retry}
          onClick={handleCheckUpdate}
          disabled={updateChecking || !!downloadProgress}
        >
          {t.updates.checkForUpdates}
        </Button>

        {/* Status caption beside the button — flat lookup on captionState (see
            its derivation above; 'unknown' deliberately renders nothing). The box keeps the
            button's height, so the button does not move when the words change. */}
        <div className="flex min-h-7 min-w-0 flex-1 items-center text-ui-sm text-label-secondary">
          {updateChecking && <Spinner size="sm" label={t.updates.checking} />}
          {captionState === 'unsupported' && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Icon icon={AppIcons.info} size="sm" className="text-label-tertiary" />
              <span>{t.updates.unsupportedBuild}</span>
              <Pressable onClick={() => void handleOpenLink(OFFICIAL_WEBSITE_URL)} className={TEXT_LINK}>
                <Icon icon={AppIcons.openExternal} size="sm" />
                {t.updates.getFromWebsite}
              </Pressable>
            </div>
          )}
          {captionState === 'error' && (
            <div className="flex items-center gap-2 text-danger">
              <StatusIcon tone="danger" size="sm" />
              <span>{t.updates.checkFailed}</span>
            </div>
          )}
          {captionState === 'up-to-date' && (
            <div className="flex items-center gap-2">
              <StatusIcon tone="success" size="sm" />
              <span>{t.updates.upToDate}</span>
              {checkResult === 'just-checked' && (
                <span>· {t.updates.justChecked}</span>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
