import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n, type LanguageSetting } from '@/i18n';
import {
  Settings,
  Globe,
  Palette,
  HelpCircle,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Download,
  ChevronsUpDown,
  Pencil,
} from 'lucide-react';
import DefaultUserAvatar from '@/components/common/DefaultUserAvatar';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/utils/version';
import { checkForUpdate, downloadAndInstallUpdate, restartApp } from '@/core/updates/checker';

/**
 * Account / preferences popover anchored to the sidebar's bottom user row.
 *
 * Replaces the previous three flat icon buttons (avatar / settings / help) with
 * a single avatar trigger that opens a popover — mirrors Claude / TRAE / WorkBuddy.
 * High-frequency prefs are surfaced inline so the user doesn't have to open the
 * full settings dialog: theme toggles in place, language switches via an inline
 * select, and check-for-updates runs the real update flow (check → download →
 * restart) reusing the store-backed update state. As an open-source BYO-key
 * client there is deliberately no account / plan / logout — the identity head
 * reads "本地模式".
 */
export default function AccountMenu({ onEditProfile }: { onEditProfile: () => void }) {
  const { t } = useI18n();
  const userNickname = useSettingsStore((s) => s.userNickname);
  const userAvatar = useSettingsStore((s) => s.userAvatar);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  const openGuide = useSettingsStore((s) => s.openGuide);
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const updateChecking = useSettingsStore((s) => s.updateChecking);
  const downloadProgress = useSettingsStore((s) => s.updateDownloadProgress);
  const updateInstalling = useSettingsStore((s) => s.updateInstalling);

  const [open, setOpen] = useState(false);
  const [checkedResult, setCheckedResult] = useState<'idle' | 'up-to-date'>('idle');
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Navigation items close the popover; inline controls (theme, language,
  // update) keep it open so the user sees the change take effect.
  const run = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const handleCheck = useCallback(async () => {
    setCheckedResult('idle');
    try {
      const result = await checkForUpdate(true);
      if (!result) {
        setCheckedResult('up-to-date');
        setTimeout(() => setCheckedResult('idle'), 3000);
      }
    } catch {
      // checker surfaces its own error state; nothing extra to do here
    }
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      await downloadAndInstallUpdate();
    } catch {
      // download error is reflected in the About section; keep popover quiet
    }
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      await restartApp();
    } catch {
      /* no-op */
    }
  }, []);

  const languageOptions = [
    { value: 'system', label: t.settings.followSystem },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  const themeOptions = [
    { value: 'light', label: t.settings.appearanceLight },
    { value: 'system', label: t.settings.appearanceSystem },
    { value: 'dark', label: t.settings.appearanceDark },
  ] as const;

  const progressPercent =
    downloadProgress && downloadProgress.total > 0
      ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
      : 0;

  // Resolve the check-update row into a single state.
  const updateRow: {
    icon: typeof RefreshCw;
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    spin?: boolean;
    accent?: boolean;
    trailing?: ReactNode;
  } = updateInstalling
    ? { icon: RotateCcw, label: t.updates.restartToInstall, onClick: handleRestart, accent: true }
    : downloadProgress
      ? { icon: Download, label: `${t.updates.downloading} ${progressPercent}%`, disabled: true, accent: true }
      : updateInfo
        ? {
            icon: Download,
            label: t.updates.downloadUpdate,
            onClick: handleDownload,
            accent: true,
            trailing: (
              <span className="text-[11px] font-semibold text-[var(--abu-clay)]">v{updateInfo.version}</span>
            ),
          }
        : updateChecking
          ? { icon: RefreshCw, label: t.updates.checking, disabled: true, spin: true }
          : checkedResult === 'up-to-date'
            ? { icon: RefreshCw, label: t.updates.upToDate, onClick: handleCheck }
            : {
                icon: RefreshCw,
                label: t.updates.update,
                onClick: handleCheck,
                trailing: <span className="text-[12px] text-[var(--abu-text-muted)]">v{APP_VERSION}</span>,
              };
  const UpdateIcon = updateRow.icon;

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger — single row replacing the old three buttons */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl border transition-colors text-left',
          open
            ? 'bg-[var(--abu-bg-active)] border-[var(--abu-border)]'
            : 'border-transparent hover:bg-[var(--abu-bg-hover)]'
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="w-8 h-8 rounded-full overflow-hidden shrink-0">
          {userAvatar ? (
            <img src={userAvatar} alt="" className="w-full h-full object-cover" />
          ) : (
            <DefaultUserAvatar />
          )}
        </span>
        <span
          className={cn(
            'flex-1 min-w-0 text-[13px] font-semibold truncate',
            userNickname ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-tertiary)]'
          )}
        >
          {userNickname || t.sidebar.defaultNickname}
        </span>
        {updateInfo && !open && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />}
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" strokeWidth={1.6} />
      </button>

      {/* Popover */}
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-2 z-50 p-1.5 rounded-2xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-[0_12px_34px_-8px_rgba(20,20,19,0.22),0_2px_8px_-2px_rgba(20,20,19,0.10)]"
        >
          {/* Identity head */}
          <div className="group flex items-center gap-2.5 px-2 py-2">
            <span className="w-9 h-9 rounded-full overflow-hidden shrink-0">
              {userAvatar ? (
                <img src={userAvatar} alt="" className="w-full h-full object-cover" />
              ) : (
                <DefaultUserAvatar />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate text-[var(--abu-text-primary)]">
                {userNickname || t.sidebar.defaultNickname}
              </div>
              <div className="text-[11px] text-[var(--abu-text-muted)] truncate">{t.sidebar.localMode}</div>
            </div>
            <button
              onClick={() => run(onEditProfile)}
              title={t.sidebar.editProfile}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] hover:bg-[var(--abu-bg-hover)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition"
            >
              <Pencil className="h-[15px] w-[15px]" strokeWidth={1.7} />
            </button>
          </div>

          <div className="mx-1.5 my-1 h-px bg-[var(--abu-border)]" />

          {/* Settings */}
          <MenuRow icon={Settings} label={t.settings.title} onClick={() => run(() => openSystemSettings())} />

          {/* Language — borderless ghost select (value + small chevron, iOS-style) */}
          <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-xl">
            <Globe className="h-[17px] w-[17px] shrink-0 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
            <span className="flex-1 text-[13px] text-[var(--abu-text-secondary)]">{t.settings.language}</span>
            <Select
              variant="ghost"
              value={language}
              options={languageOptions}
              onChange={(v) => setLanguage(v as LanguageSetting)}
            />
          </div>

          {/* Appearance — borderless ghost select (matches the Language row) */}
          <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-xl">
            <Palette className="h-[17px] w-[17px] shrink-0 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
            <span className="flex-1 text-[13px] text-[var(--abu-text-secondary)]">{t.settings.appearance}</span>
            <Select
              variant="ghost"
              value={theme}
              options={themeOptions.map(({ value, label }) => ({ value, label }))}
              onChange={(v) => setTheme(v as typeof theme)}
            />
          </div>

          <div className="mx-1.5 my-1 h-px bg-[var(--abu-border)]" />

          {/* Help */}
          <MenuRow icon={HelpCircle} label={t.sidebar.help} onClick={() => run(() => openGuide())} />

          {/* Feedback */}
          <MenuRow
            icon={MessageCircle}
            label={t.about.feedback}
            onClick={() => run(() => openSystemSettings('feedback'))}
          />

          {/* Check for updates — runs the real flow inline (keeps popover open) */}
          <button
            role="menuitem"
            onClick={updateRow.onClick}
            disabled={updateRow.disabled}
            className={cn(
              'w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors',
              updateRow.disabled ? 'cursor-default' : 'hover:bg-[var(--abu-bg-hover)]'
            )}
          >
            <UpdateIcon
              className={cn(
                'h-[17px] w-[17px] shrink-0',
                updateRow.accent ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]',
                updateRow.spin && 'animate-spin'
              )}
              strokeWidth={1.6}
            />
            <span
              className={cn(
                'flex-1 text-[13px]',
                updateRow.accent ? 'text-[var(--abu-clay)] font-medium' : 'text-[var(--abu-text-secondary)]'
              )}
            >
              {updateRow.label}
            </span>
            {updateRow.trailing}
          </button>
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onClick,
  trailing,
}: {
  icon: typeof Settings;
  label: string;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors hover:bg-[var(--abu-bg-hover)]"
    >
      <Icon className="h-[17px] w-[17px] shrink-0 text-[var(--abu-text-tertiary)]" strokeWidth={1.6} />
      <span className="flex-1 text-[13px] text-[var(--abu-text-secondary)]">{label}</span>
      {trailing}
    </button>
  );
}
