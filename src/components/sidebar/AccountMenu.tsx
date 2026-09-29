import { useState, useRef, useCallback, type ComponentProps, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAccountStore } from '@/core/account/accountStore';
import { startEnterpriseAccountLogin } from '@/core/enterprise/accountLogin';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { IS_ENTERPRISE_BUILD } from '@/config/featureGates';
import { useI18n, type LanguageSetting } from '@/i18n';
import { Avatar } from '@/components/ds/avatar';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuSeparator } from '@/components/ds/menu';
import { Select } from '@/components/ds/select';
import { Spinner } from '@/components/ds/spinner';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/utils/version';
import { checkForUpdate, downloadAndInstallUpdate, restartApp } from '@/core/updates/checker';
import { getUpdateProgressPresentation } from '@/core/updates/progress';
import { getHelpDocsUrl, OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';

type IconGlyph = ComponentProps<typeof Icon>['icon'];

/**
 * Account / preferences menu anchored to the sidebar's bottom user row.
 *
 * A single avatar trigger opens the menu — mirrors Claude / TRAE / WorkBuddy.
 * High-frequency prefs are surfaced inline so the user doesn't have to open the
 * full settings dialog: theme and language switch via inline selects, and
 * check-for-updates runs the real update flow (check → download → restart)
 * reusing the store-backed update state. Those inline controls keep the menu
 * open so the user sees the change take effect.
 */
export default function AccountMenu({ onEditProfile }: { onEditProfile: () => void }) {
  const { t, locale } = useI18n();
  const userNickname = useSettingsStore((s) => s.userNickname);
  const userAvatar = useSettingsStore((s) => s.userAvatar);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  const openAccountLogin = useSettingsStore((s) => s.openAccountLogin);
  const accountStatus = useAccountStore((s) => s.status);
  const account = useAccountStore((s) => s.account);
  const profileStatus = useAccountStore((s) => s.profileStatus);
  const signOut = useAccountStore((s) => s.signOut);
  const enterpriseMode = useEnterpriseStore((s) => s.mode);
  const unbindEnterprise = useEnterpriseStore((s) => s.unbind);
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const updateChecking = useSettingsStore((s) => s.updateChecking);
  const downloadProgress = useSettingsStore((s) => s.updateDownloadProgress);
  const updateInstalling = useSettingsStore((s) => s.updateInstalling);
  const updaterUnsupported = useSettingsStore((s) => s.updaterUnsupported);

  const [open, setOpen] = useState(false);
  const [checkedResult, setCheckedResult] = useState<'idle' | 'up-to-date'>('idle');
  // Settings, profile, feedback and sign-in open dialogs of their own: they start
  // once the menu has gone, so no dialog opens inside or under the closing menu.
  const afterMenuClose = useRef<(() => void) | null>(null);
  const openAfterClose = (action: () => void) => { afterMenuClose.current = action; };

  const handleCheck = useCallback(async () => {
    setCheckedResult('idle');
    try {
      const result = await checkForUpdate(true);
      switch (result.kind) {
        case 'up-to-date':
          setCheckedResult('up-to-date');
          setTimeout(() => setCheckedResult('idle'), 3000);
          break;
        case 'error':
          if (!result.updaterUnsupported) {
            setCheckedResult('up-to-date');
            setTimeout(() => setCheckedResult('idle'), 3000);
          }
          break;
        case 'update':
        case 'disabled':
        case 'throttled':
          break;
      }
    } catch {
      // checker surfaces its own error state; nothing extra to do here
    }
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      await downloadAndInstallUpdate();
    } catch {
      // download error is reflected in the About section; keep the menu quiet
    }
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      await restartApp();
    } catch {
      /* no-op */
    }
  }, []);

  const handleOpenHelp = useCallback(() => {
    void openUrl(getHelpDocsUrl(locale)).catch((error) => {
      console.error('[AccountMenu] Failed to open help documentation:', error);
    });
  }, [locale]);

  const handleEnterpriseLogin = useCallback(() => {
    void startEnterpriseAccountLogin()
      .then((result) => {
        if (result === 'configuration_required') openSystemSettings('enterprise');
      })
      .catch(() => openSystemSettings('enterprise'));
  }, [openSystemSettings]);

  const languageOptions = [
    { value: 'system', label: t.settings.followSystem },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  // 「跟随系统」排第一，和上面的语言一行读法一致：默认在最前，具体选项在后。
  const themeOptions = [
    { value: 'system', label: t.settings.appearanceSystem },
    { value: 'light', label: t.settings.appearanceLight },
    { value: 'dark', label: t.settings.appearanceDark },
  ];

  const progressPresentation = downloadProgress
    ? getUpdateProgressPresentation(downloadProgress)
    : null;
  const downloadLabel = downloadProgress?.phase === 'preparing'
    ? t.updates.preparingDownload
    : downloadProgress?.phase === 'verifying'
      ? t.updates.verifying
      : progressPresentation?.percentLabel
        ? `${t.updates.downloading} ${progressPresentation.percentLabel}%`
        : t.updates.downloading;

  // Resolve the check-update row into a single state. A spinning row shows a
  // spinner in place of its icon.
  const updateRow: {
    icon?: IconGlyph;
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    accent?: boolean;
    version?: string;
  } = updateInstalling
    ? { icon: AppIcons.restart, label: t.updates.restartToInstall, onClick: handleRestart, accent: true }
    : downloadProgress
      ? { label: downloadLabel, disabled: true, accent: true }
      : updateInfo
        ? {
            icon: AppIcons.download,
            label: t.updates.downloadUpdate,
            onClick: handleDownload,
            accent: true,
            version: `v${updateInfo.version}`,
          }
        : updateChecking
          ? { label: t.updates.checking, disabled: true }
          : updaterUnsupported
            // Never claim "up to date" when the updater is disabled in this
            // build (non-official package / dev shell) — offer the official
            // download site instead.
            ? {
                icon: AppIcons.openExternal,
                label: t.updates.unsupportedBuildShort,
                onClick: () => void openUrl(OFFICIAL_WEBSITE_URL).catch(() => {}),
              }
            : checkedResult === 'up-to-date'
              ? { icon: AppIcons.retry, label: t.updates.upToDate, onClick: handleCheck }
              : {
                  icon: AppIcons.retry,
                  label: t.updates.update,
                  onClick: handleCheck,
                  version: `v${APP_VERSION}`,
                };
  const signedIn = accountStatus === 'signed_in' && account !== null;
  const expired = accountStatus === 'expired' && account !== null;
  const localLabel = userNickname || t.sidebar.defaultNickname;
  const enterpriseBinding = enterpriseMode.kind === 'enterprise' || enterpriseMode.kind === 'offline'
    ? enterpriseMode.binding
    : null;
  const enterpriseSignedIn = enterpriseBinding !== null;
  const hasDisplayedIdentity = signedIn || enterpriseSignedIn;
  const accountLabel = enterpriseBinding
    ? enterpriseBinding.userName || enterpriseBinding.userEmail || enterpriseBinding.orgName
    : signedIn
      ? account.name || account.email || t.account.title
      : localLabel;
  const accountDetail = enterpriseBinding
    ? [enterpriseBinding.userEmail, enterpriseBinding.orgName].filter(Boolean).join(' · ')
    : signedIn
      ? profileStatus === 'loading'
        ? t.account.profileLoading
        : profileStatus === 'error'
          ? t.account.profileUnavailable
          : account.email || t.account.title
      : t.sidebar.localMode;

  // The name beside it already says who this is, so the picture stays out of the
  // accessible name.
  const avatar = (size: 'sm' | 'lg') => (
    <span aria-hidden="true" className="flex shrink-0">
      <Avatar name={accountLabel} src={userAvatar || undefined} size={size} />
    </span>
  );

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      side="top"
      onCloseAutoFocus={() => {
        const action = afterMenuClose.current;
        if (!action) return;
        afterMenuClose.current = null;
        // Focus still returns to the trigger, as before; a dialog that focuses a field
        // on mount takes it after this.
        action();
      }}
      trigger={
        <Button variant="plain" className="w-full justify-start gap-2 px-2">
          {avatar('sm')}
          <span className={cn('min-w-0 flex-1 truncate text-left', hasDisplayedIdentity ? 'text-label' : 'text-label-tertiary')}>
            {accountLabel}
          </span>
          {updateInfo && !open && <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />}
          <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-tertiary" />
        </Button>
      }
    >
      <div className="w-60">
        {/* Authenticated identity, or the local-mode account entry. */}
        <div className="group flex items-center gap-2 px-2 py-2">
          {avatar('lg')}
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-semibold text-label">{accountLabel}</div>
            <div className="truncate text-caption text-label-tertiary">{accountDetail}</div>
          </div>
          <IconButton
            icon={AppIcons.rename}
            label={t.sidebar.editProfile}
            size="sm"
            onClick={() => { afterMenuClose.current = onEditProfile; setOpen(false); }}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          />
        </div>

        <MenuSeparator />

        {!enterpriseSignedIn && signedIn && (
          <>
            <MenuItem icon={AppIcons.account} onSelect={() => openAfterClose(() => openSystemSettings('account'))}>
              {t.account.accountSettings}
            </MenuItem>
            {IS_ENTERPRISE_BUILD && (
              <MenuItem icon={AppIcons.signIn} onSelect={() => openAfterClose(handleEnterpriseLogin)}>
                {t.account.switchToEnterprise}
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}

        <MenuItem icon={AppIcons.settings} onSelect={() => openAfterClose(() => openSystemSettings())}>
          {t.settings.title}
        </MenuItem>

        <PreferenceRow icon={AppIcons.language} label={t.settings.language}>
          <Select
            label={t.settings.language}
            value={language}
            options={languageOptions}
            onValueChange={(v) => setLanguage(v as LanguageSetting)}
          />
        </PreferenceRow>

        <PreferenceRow icon={AppIcons.appearance} label={t.settings.appearance}>
          <Select
            label={t.settings.appearance}
            value={theme}
            options={themeOptions}
            onValueChange={(v) => setTheme(v as typeof theme)}
          />
        </PreferenceRow>

        <MenuSeparator />

        <MenuItem icon={AppIcons.help} onSelect={handleOpenHelp}>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{t.sidebar.help}</span>
            <Icon icon={AppIcons.openExternal} size="sm" className="text-label-tertiary" />
          </span>
        </MenuItem>

        <MenuItem icon={AppIcons.feedback} onSelect={() => openAfterClose(() => openSystemSettings('feedback'))}>
          {t.about.feedback}
        </MenuItem>

        {/* Check for updates — runs the real flow inline and keeps the menu open */}
        <MenuItem
          icon={updateRow.icon}
          shortcut={updateRow.version}
          disabled={updateRow.disabled}
          onSelect={(event) => {
            event.preventDefault();
            updateRow.onClick?.();
          }}
        >
          {updateRow.icon
            ? <span className={cn(updateRow.accent && 'font-medium')}>{updateRow.label}</span>
            : <Spinner size="sm" label={updateRow.label} />}
        </MenuItem>

        <MenuSeparator />

        {enterpriseSignedIn ? (
          <MenuItem icon={AppIcons.signOut} onSelect={() => void unbindEnterprise()}>
            {t.account.signOutEnterprise}
          </MenuItem>
        ) : signedIn ? (
          <MenuItem icon={AppIcons.signOut} onSelect={() => void signOut()}>
            {IS_ENTERPRISE_BUILD ? t.account.signOutPersonal : t.account.signOut}
          </MenuItem>
        ) : (
          <MenuItem icon={AppIcons.signIn} onSelect={() => openAfterClose(openAccountLogin)}>
            {expired ? t.account.retry : t.account.signIn}
          </MenuItem>
        )}
      </div>
    </Menu>
  );
}

// A menu line that holds its own control (language, appearance) instead of being an item.
function PreferenceRow({ icon, label, children }: { icon: IconGlyph; label: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 px-2">
      <Icon icon={icon} size="sm" className="text-label-secondary" />
      <span className="min-w-0 flex-1 truncate text-ui text-label">{label}</span>
      {children}
    </div>
  );
}
