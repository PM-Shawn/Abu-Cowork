import { useState, useCallback, useRef, useEffect } from 'react';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { openUrl } from '@tauri-apps/plugin-opener';
import { RefreshCw, Download, CheckCircle, CircleAlert, RotateCcw, ExternalLink, Copy, Check } from 'lucide-react';
import { getDeviceId } from '@/utils/deviceId';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { APP_VERSION } from '@/utils/version';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate, downloadAndInstallUpdate, restartApp, refreshUpdateNotes } from '@/core/updates/checker';
import { getUpdateProgressPresentation } from '@/core/updates/progress';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type CheckResult = 'idle' | 'just-checked' | 'error';


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
    setDownloadError(null);
    try {
      await downloadAndInstallUpdate();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRestart = useCallback(async () => {
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
      <div className="space-y-1">
        <div className="flex justify-between items-center py-3 border-b border-[var(--abu-border)]">
          <span className="text-body text-[var(--abu-text-tertiary)]">{t.updates.currentVersion}</span>
          <span className="text-body font-semibold text-[var(--abu-text-primary)]">v{APP_VERSION}</span>
        </div>
        <div className="flex justify-between items-center py-3 border-b border-[var(--abu-border)]">
          <span className="text-body text-[var(--abu-text-tertiary)]">{t.about.deviceId}</span>
          <button
            type="button"
            onClick={handleCopyDeviceId}
            className="flex items-center gap-1.5 text-body font-mono text-[var(--abu-text-secondary)] hover:text-[var(--abu-text-primary)] transition-colors"
            title={deviceId}
          >
            <span>{deviceId.slice(0, 8)}</span>
            {idCopied ? <Check className="h-3.5 w-3.5 text-[var(--abu-success)]" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Update card */}
      {updateInfo && (
        <div className="rounded-xl border border-[var(--abu-clay-ring)] bg-[var(--abu-clay-5)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-body font-semibold text-[var(--abu-clay)]">{t.updates.newVersionAvailable}</span>
            <span className="text-body font-mono font-semibold text-[var(--abu-text-primary)]">v{updateInfo.version}</span>
          </div>
          {(updateInfo.releaseNotes || updateInfo.releaseUrl) && (
            <div className="space-y-1.5">
              <span className="text-minor font-medium text-[var(--abu-text-tertiary)]">{t.updates.releaseNotes}</span>
              {updateInfo.releaseNotes && updateInfo.releaseNotes.trim().length > 0 ? (
                <div className="text-body text-[var(--abu-text-secondary)] space-y-1.5
                  [&_h3]:text-minor [&_h3]:font-semibold [&_h3]:text-[var(--abu-text-primary)] [&_h3]:mt-2
                  [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5
                  [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5
                  [&_strong]:font-semibold [&_strong]:text-[var(--abu-text-primary)]
                  [&_p]:leading-relaxed">
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
                          className="text-[var(--abu-clay)] hover:underline cursor-pointer"
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
                <button
                  onClick={() => void handleOpenLink(updateInfo.releaseUrl)}
                  className="flex items-center gap-1.5 text-minor text-[var(--abu-clay)] hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t.updates.viewOnGitHub}
                </button>
              )}
            </div>
          )}

          {/* Download progress bar */}
          {downloadProgress && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-minor text-[var(--abu-text-tertiary)]">
                <span>{progressStatus}</span>
                {progressPresentation?.percentLabel && (
                  <span className="tabular-nums">{progressPresentation.percentLabel}%</span>
                )}
              </div>
              <div
                className="w-full h-2 rounded-full bg-[var(--abu-bg-active)] overflow-hidden"
                role="progressbar"
                aria-label={progressStatus}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPresentation?.percent ?? undefined}
              >
                {progressPresentation?.indeterminate ? (
                  <div className="update-progress-indeterminate h-full rounded-full bg-[var(--abu-clay)]" />
                ) : (
                  // Snap to the real value instead of easing behind frequent
                  // updater events. The one-decimal label keeps slow downloads
                  // visibly alive even while the fill advances by tiny amounts.
                  <div
                    className="h-full rounded-full bg-[var(--abu-clay)]"
                    style={{ width: `${progressPresentation?.percent ?? 0}%` }}
                  />
                )}
              </div>
            </div>
          )}

          {/* Download error */}
          {downloadError && (
            <div className="flex items-center gap-2 text-body text-[var(--abu-danger)]">
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t.updates.downloadFailed}</span>
              <button
                onClick={handleDownload}
                className="text-minor font-medium text-[var(--abu-clay)] hover:underline"
              >
                {t.updates.retry}
              </button>
            </div>
          )}

          {/* Action buttons */}
          {updateInstalling ? (
            <button
              onClick={handleRestart}
              className="flex items-center gap-2 w-full justify-center py-2 px-4 rounded-lg bg-[var(--abu-success-solid)] text-white text-body font-medium hover:opacity-90 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              {t.updates.restartToInstall}
            </button>
          ) : !downloadProgress && !downloadError && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 w-full justify-center py-2 px-4 rounded-lg bg-[var(--abu-clay)] text-white text-body font-medium hover:bg-[var(--abu-clay-hover)] transition-colors"
            >
              <Download className="h-4 w-4" />
              {t.updates.downloadUpdate}
            </button>
          )}
        </div>
      )}

      {/* Check for updates button */}
      <div className="space-y-2">
        <button
          onClick={handleCheckUpdate}
          disabled={updateChecking || !!downloadProgress}
          className={cn(
            'flex items-center gap-2 w-full justify-center py-2.5 px-4 rounded-lg border text-body font-medium transition-all duration-200',
            updateChecking || downloadProgress
              ? 'border-[var(--abu-border)] text-[var(--abu-text-muted)] cursor-not-allowed'
              : 'border-[var(--abu-border)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] hover:border-[var(--abu-border-hover)] active:scale-[0.98]'
          )}
        >
          <RefreshCw className={cn('h-4 w-4 transition-transform', updateChecking && 'animate-spin')} />
          {updateChecking ? t.updates.checking : t.updates.checkForUpdates}
        </button>

        {/* Status caption under the button — flat lookup on captionState (see
            its derivation above; 'unknown' deliberately renders nothing). */}
        {captionState === 'unsupported' && (
          <div className="flex flex-col items-center gap-1 text-minor text-[var(--abu-text-muted)]">
            <div className="flex items-center justify-center gap-1.5">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="text-center">{t.updates.unsupportedBuild}</span>
            </div>
            <button
              onClick={() => void handleOpenLink(OFFICIAL_WEBSITE_URL)}
              className="flex items-center gap-1 text-[var(--abu-clay)] hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t.updates.getFromWebsite}
            </button>
          </div>
        )}
        {captionState === 'error' && (
          <div className="flex items-center justify-center gap-1.5 text-minor transition-all duration-300 text-[var(--abu-danger)]">
            <CircleAlert className="h-3.5 w-3.5" />
            <span>{t.updates.checkFailed}</span>
          </div>
        )}
        {captionState === 'up-to-date' && (
          <div className="flex items-center justify-center gap-1.5 text-minor transition-all duration-300 text-[var(--abu-text-muted)]">
            <CheckCircle className="h-3.5 w-3.5 text-[var(--abu-success)]" />
            <span>{t.updates.upToDate}</span>
            {checkResult === 'just-checked' && (
              <span className="text-[var(--abu-text-muted)]">· {t.updates.justChecked}</span>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
