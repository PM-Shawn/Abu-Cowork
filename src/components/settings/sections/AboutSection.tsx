import { useState, useCallback, useRef } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { RefreshCw, Download, CheckCircle, CircleAlert, RotateCcw, ExternalLink, Copy, Check } from 'lucide-react';
import { getDeviceId } from '@/utils/deviceId';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import abuAvatar from '@/assets/abu-avatar.png';
import { APP_VERSION } from '@/utils/version';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate, downloadAndInstallUpdate, restartApp } from '@/core/updates/checker';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type CheckResult = 'idle' | 'just-checked' | 'error';

const DISCLAIMER_URL_BASE = 'https://github.com/PM-Shawn/Abu-Cowork/blob/main';

export default function AboutSection() {
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const disclaimerRef = useRef<HTMLDivElement>(null);
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const updateChecking = useSettingsStore((s) => s.updateChecking);
  const downloadProgress = useSettingsStore((s) => s.updateDownloadProgress);
  const updateInstalling = useSettingsStore((s) => s.updateInstalling);
  const { t, locale } = useI18n();
  const disclaimerUrl = `${DISCLAIMER_URL_BASE}/${locale === 'zh-CN' ? 'DISCLAIMER.zh-CN.md' : 'DISCLAIMER.md'}`;
  const [checkResult, setCheckResult] = useState<CheckResult>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [idCopied, setIdCopied] = useState(false);
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
      if (!result) {
        setCheckResult('just-checked');
        setTimeout(() => setCheckResult('idle'), 3000);
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

  const progressPercent = downloadProgress
    ? downloadProgress.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : 0
    : 0;

  return (
    <div className="min-h-full flex flex-col justify-center gap-6">
      {/* Logo & name */}
      <div className="flex flex-col items-center text-center space-y-3">
        <img src={abuAvatar} alt="Abu" className="w-20 h-20 rounded-2xl" />
        <div>
          <h4 className="text-2xl font-bold text-[var(--abu-text-primary)]">{t.common.appName}</h4>
          <p className="text-sm text-[var(--abu-text-tertiary)]">{t.common.appSlogan}</p>
        </div>
      </div>

      {/* Version info */}
      <div className="space-y-1">
        <div className="flex justify-between items-center py-3 border-b border-[var(--abu-border)]">
          <span className="text-sm text-[var(--abu-text-tertiary)]">{t.updates.currentVersion}</span>
          <span className="text-sm font-semibold text-[var(--abu-text-primary)]">v{APP_VERSION}</span>
        </div>
        <div className="flex justify-between items-center py-3 border-b border-[var(--abu-border)]">
          <span className="text-sm text-[var(--abu-text-tertiary)]">{t.about.deviceId}</span>
          <button
            type="button"
            onClick={handleCopyDeviceId}
            className="flex items-center gap-1.5 text-sm font-mono text-[var(--abu-text-secondary)] hover:text-[var(--abu-text-primary)] transition-colors"
            title={deviceId}
          >
            <span>{deviceId.slice(0, 8)}</span>
            {idCopied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Update card */}
      {updateInfo && (
        <div className="rounded-xl border border-[var(--abu-clay-ring)] bg-[var(--abu-clay-5)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-[var(--abu-clay)]">{t.updates.newVersionAvailable}</span>
            <span className="text-sm font-mono font-semibold text-[var(--abu-text-primary)]">v{updateInfo.version}</span>
          </div>
          {(updateInfo.releaseNotes || updateInfo.releaseUrl) && (
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.updates.releaseNotes}</span>
              {updateInfo.releaseNotes && updateInfo.releaseNotes.trim().length > 0 ? (
                <div className="text-sm text-[var(--abu-text-secondary)] space-y-1.5
                  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-[var(--abu-text-primary)] [&_h3]:mt-2
                  [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5
                  [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5
                  [&_strong]:font-semibold [&_strong]:text-[var(--abu-text-primary)]
                  [&_p]:leading-relaxed">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
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
                  className="flex items-center gap-1.5 text-xs text-[var(--abu-clay)] hover:underline"
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
              <div className="flex justify-between text-xs text-[var(--abu-text-tertiary)]">
                <span>{t.updates.downloading}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[var(--abu-bg-active)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--abu-clay)] transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Download error */}
          {downloadError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t.updates.downloadFailed}</span>
              <button
                onClick={handleDownload}
                className="text-xs font-medium text-[var(--abu-clay)] hover:underline"
              >
                {t.updates.retry}
              </button>
            </div>
          )}

          {/* Action buttons */}
          {updateInstalling ? (
            <button
              onClick={handleRestart}
              className="flex items-center gap-2 w-full justify-center py-2 px-4 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              {t.updates.restartToInstall}
            </button>
          ) : !downloadProgress && !downloadError && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 w-full justify-center py-2 px-4 rounded-lg bg-[var(--abu-clay)] text-white text-sm font-medium hover:bg-[var(--abu-clay-hover)] transition-colors"
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
            'flex items-center gap-2 w-full justify-center py-2.5 px-4 rounded-lg border text-sm font-medium transition-all duration-200',
            updateChecking || downloadProgress
              ? 'border-[var(--abu-border)] text-[var(--abu-text-muted)] cursor-not-allowed'
              : 'border-[var(--abu-border)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] hover:border-[var(--abu-border-hover)] active:scale-[0.98]'
          )}
        >
          <RefreshCw className={cn('h-4 w-4 transition-transform', updateChecking && 'animate-spin')} />
          {updateChecking ? t.updates.checking : t.updates.checkForUpdates}
        </button>

        {/* Up-to-date / check-result status — subtle caption under the button */}
        {!updateInfo && !updateChecking && (
          <div
            className={cn(
              'flex items-center justify-center gap-1.5 text-xs transition-all duration-300',
              checkResult === 'error' ? 'text-red-500' : 'text-[var(--abu-text-muted)]'
            )}
          >
            {checkResult === 'error' ? (
              <>
                <CircleAlert className="h-3.5 w-3.5" />
                <span>{t.updates.checkFailed}</span>
              </>
            ) : (
              <>
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span>{t.updates.upToDate}</span>
                {checkResult === 'just-checked' && (
                  <span className="text-[var(--abu-text-muted)]">· {t.updates.justChecked}</span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-center space-y-2 pt-2">
        <p className="text-sm text-[var(--abu-text-tertiary)]">
          Made with ❤️ by{' '}
          <button
            onClick={() => handleOpenLink('https://github.com/PM-Shawn/Abu-Cowork')}
            className="text-[var(--abu-clay)] hover:underline font-medium"
          >
            Shawn
          </button>
        </p>
        <p className="text-xs text-[var(--abu-text-muted)]">
          © 2026 {t.common.appName}. All rights reserved.
          <span className="mx-1.5">·</span>
          <button
            onClick={() => {
              setDisclaimerOpen((o) => !o);
              if (!disclaimerOpen) {
                setTimeout(() => disclaimerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
              }
            }}
            className={cn(
              'transition-colors',
              disclaimerOpen
                ? 'text-[var(--abu-text-secondary)]'
                : 'hover:text-[var(--abu-text-secondary)]',
            )}
          >
            {t.about.disclaimerLink}
          </button>
        </p>
      </div>

      {/* Expandable disclaimer content — renders below footer */}
      {disclaimerOpen && (
        <div
          ref={disclaimerRef}
          className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-active)] p-3 max-h-64 overflow-y-auto space-y-2"
        >
          <p className="text-xs font-semibold text-[var(--abu-text-primary)]">{t.about.disclaimerTitle}</p>
          <div className="text-xs text-[var(--abu-text-secondary)] space-y-1.5 leading-relaxed">
            <p>· {t.disclaimerBanner.line1}</p>
            <p>· {t.disclaimerBanner.line2}</p>
            <p>· {t.disclaimerBanner.line3}</p>
          </div>
          <button
            onClick={() => void handleOpenLink(disclaimerUrl)}
            className="flex items-center gap-1 text-xs text-[var(--abu-clay)] hover:underline mt-1"
          >
            <ExternalLink className="h-3 w-3" />
            {t.about.disclaimerLink}{t.about.disclaimerFullSuffix}
          </button>
          <button
            onClick={() => setDisclaimerOpen(false)}
            className="block text-xs text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] mt-1"
          >
            {t.about.disclaimerClose}
          </button>
        </div>
      )}
    </div>
  );
}
