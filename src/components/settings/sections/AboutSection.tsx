import { useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { RefreshCw, Download, CheckCircle, CircleAlert } from 'lucide-react';
import abuAvatar from '@/assets/abu-avatar.png';
import { APP_VERSION } from '@/utils/version';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate } from '@/core/updates/checker';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

type CheckResult = 'idle' | 'just-checked' | 'error';

export default function AboutSection() {
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const updateChecking = useSettingsStore((s) => s.updateChecking);
  const { t } = useI18n();
  const [checkResult, setCheckResult] = useState<CheckResult>('idle');

  const handleOpenLink = async (url: string) => {
    try {
      await open(url);
    } catch (e) {
      console.error('Failed to open link:', e);
    }
  };

  const handleCheckUpdate = useCallback(async () => {
    setCheckResult('idle');
    try {
      const result = await checkForUpdate(true);
      // If no new version found (result is null and no updateInfo), show "just checked" feedback
      if (!result) {
        setCheckResult('just-checked');
        // Reset after 3 seconds
        setTimeout(() => setCheckResult('idle'), 3000);
      }
    } catch {
      setCheckResult('error');
      setTimeout(() => setCheckResult('idle'), 3000);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Logo & name */}
      <div className="flex flex-col items-center text-center space-y-3">
        <img src={abuAvatar} alt="阿布" className="w-20 h-20 rounded-2xl" />
        <div>
          <h4 className="text-2xl font-bold text-[var(--abu-text-primary)]">{t.common.appName}</h4>
          <p className="text-sm text-[var(--abu-text-tertiary)]">{t.common.appSlogan}</p>
        </div>
      </div>

      {/* Version info */}
      <div className="space-y-1">
        <div className="flex justify-between items-center py-3 border-b border-[var(--abu-border)]">
          <span className="text-sm text-[var(--abu-text-tertiary)]">{t.updates.currentVersion}</span>
          <span className="text-sm font-semibold text-[var(--abu-text-primary)]">
            v{APP_VERSION}
          </span>
        </div>
      </div>

      {/* Update card */}
      {updateInfo ? (
        <div className="rounded-xl border border-[var(--abu-clay-ring)] bg-[var(--abu-clay-5)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-[var(--abu-clay)]">{t.updates.newVersionAvailable}</span>
            <span className="text-sm font-mono font-semibold text-[var(--abu-text-primary)]">v{updateInfo.version}</span>
          </div>
          {updateInfo.releaseNotes && (
            <div className="space-y-1">
              <span className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.updates.releaseNotes}</span>
              <p className="text-sm text-[var(--abu-text-secondary)] whitespace-pre-line">{updateInfo.releaseNotes}</p>
            </div>
          )}
          {updateInfo.downloadUrl && (
            <button
              onClick={() => handleOpenLink(updateInfo.downloadUrl)}
              className="flex items-center gap-2 w-full justify-center py-2 px-4 rounded-lg bg-[var(--abu-clay)] text-white text-sm font-medium hover:bg-[var(--abu-clay-hover)] transition-colors"
            >
              <Download className="h-4 w-4" />
              {t.updates.downloadUpdate}
            </button>
          )}
        </div>
      ) : (
        <div
          className={cn(
            'flex items-center gap-2 py-3 text-sm transition-all duration-300',
            checkResult === 'just-checked'
              ? 'text-green-600'
              : checkResult === 'error'
                ? 'text-red-500'
                : 'text-[var(--abu-text-tertiary)]'
          )}
        >
          {checkResult === 'error' ? (
            <>
              <CircleAlert className="h-4 w-4" />
              <span>{t.updates.checkFailed}</span>
            </>
          ) : (
            <>
              <CheckCircle className={cn('h-4 w-4 text-green-500', checkResult === 'just-checked' && 'scale-110')} />
              <span>{t.updates.upToDate}</span>
              {checkResult === 'just-checked' && (
                <span className="text-xs text-[var(--abu-text-muted)] ml-auto" style={{ animation: 'fadeIn 0.3s ease-out' }}>
                  {t.updates.justChecked}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Check for updates button */}
      <button
        onClick={handleCheckUpdate}
        disabled={updateChecking}
        className={cn(
          'flex items-center gap-2 w-full justify-center py-2.5 px-4 rounded-lg border text-sm font-medium transition-all duration-200',
          updateChecking
            ? 'border-[var(--abu-border)] text-[var(--abu-text-muted)] cursor-not-allowed'
            : 'border-[var(--abu-border)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] hover:border-[var(--abu-border-hover)] active:scale-[0.98]'
        )}
      >
        <RefreshCw className={cn('h-4 w-4 transition-transform', updateChecking && 'animate-spin')} />
        {updateChecking ? t.updates.checking : t.updates.checkForUpdates}
      </button>

      {/* Footer */}
      <div className="text-center space-y-2 pt-4">
        <p className="text-sm text-[var(--abu-text-tertiary)]">
          Made with ❤️ by{' '}
          <button
              onClick={() => handleOpenLink('https://xhslink.com/m/1YlQGiTd4ls')}
              className="text-[var(--abu-clay)] hover:underline font-medium"
            >
              Shawn
            </button>
        </p>
        <p className="text-xs text-[var(--abu-text-muted)]">
          © 2026 {t.common.appName}. All rights reserved.
        </p>
      </div>
    </div>
  );
}
