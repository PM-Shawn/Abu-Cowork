import { useState, useCallback, useSyncExternalStore } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PermissionMode } from '@/core/permissions/permissionMode';
import { getAuthorizedWritablePaths, revokeWorkspace } from '@/core/tools/pathSafety';
import { useI18n } from '@/i18n';
import { isWindows } from '@/utils/platform';
import { IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { Separator } from '@/components/ds/separator';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import ComputerUseGrantsCard from './ComputerUseGrantsCard';
import { isOsSandboxCapable, syncNetworkWhitelist } from '@/core/sandbox/config';

const PERMISSION_MODES: PermissionMode[] = ['standard', 'smart', 'autonomous'];

const SUBHEADING = 'text-ui-sm font-medium text-label-tertiary';

export default function SandboxSection() {
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled);
  const setSandboxEnabled = useSettingsStore(s => s.setSandboxEnabled);
  const networkIsolationEnabled = useSettingsStore(s => s.networkIsolationEnabled);
  const setNetworkIsolationEnabled = useSettingsStore(s => s.setNetworkIsolationEnabled);
  const networkWhitelist = useSettingsStore(s => s.networkWhitelist);
  const setNetworkWhitelist = useSettingsStore(s => s.setNetworkWhitelist);
  const allowPrivateNetworks = useSettingsStore(s => s.allowPrivateNetworks);
  const setAllowPrivateNetworks = useSettingsStore(s => s.setAllowPrivateNetworks);
  const { t } = useI18n();
  const confirm = useConfirm();
  // Windows has a real OS-level sandbox too (restricted token + PowerShell
  // ConstrainedLanguage, see electron/commandHost.cjs) — the settings UI must
  // expose the same toggle there, with Windows-specific copy since the
  // mechanism differs from macOS Seatbelt (no file-path isolation).
  const windows = isWindows();
  const osSandboxAvailable = isOsSandboxCapable();
  // Per-platform copy resolved once — the Windows sandbox restricts what a
  // command may DO (privileges), not which paths it may touch, so nearly
  // every string differs from the macOS (Seatbelt path-isolation) wording.
  const copy = windows
    ? {
        sectionDescription: t.settings.sandboxDescriptionWindows,
        protectionDescription: t.settings.sandboxProtectionDescriptionWindows,
        tooltipPrimary: t.settings.sandboxWindowsMechanism,
        tooltipSecondary: t.settings.sandboxWindowsScope,
        networkIsolationDescription: t.settings.networkIsolationDescriptionWindows,
        disableWarning: t.settings.sandboxDisableWarningWindows,
      }
    : {
        sectionDescription: t.settings.sandboxDescription,
        protectionDescription: t.settings.sandboxProtectionDescription,
        tooltipPrimary: t.settings.sandboxProtectedPaths,
        tooltipSecondary: t.settings.sandboxWritablePaths,
        networkIsolationDescription: t.settings.networkIsolationDescription,
        disableWarning: t.settings.sandboxDisableWarning,
      };
  const [newDomain, setNewDomain] = useState('');

  const handleToggle = async () => {
    if (sandboxEnabled) {
      const confirmed = await confirm({
        title: t.settings.sandbox,
        message: copy.disableWarning,
        confirmLabel: t.common.confirm,
        tone: 'danger',
      });
      // The answer is about the sandbox as it is now: it may have been turned off while the question was open.
      if (confirmed && useSettingsStore.getState().sandboxEnabled) setSandboxEnabled(false);
    } else {
      setSandboxEnabled(true);
    }
  };

  const handleAddDomain = useCallback(() => {
    const trimmed = newDomain.trim();
    if (trimmed && !networkWhitelist.includes(trimmed)) {
      const updated = [...networkWhitelist, trimmed];
      setNetworkWhitelist(updated);
      syncNetworkWhitelist();
      setNewDomain('');
    }
  }, [newDomain, networkWhitelist, setNetworkWhitelist]);

  const handleRemoveDomain = useCallback((domain: string) => {
    const updated = networkWhitelist.filter(d => d !== domain);
    setNetworkWhitelist(updated);
    syncNetworkWhitelist();
  }, [networkWhitelist, setNetworkWhitelist]);

  const handlePrivateNetworkToggle = useCallback(() => {
    setAllowPrivateNetworks(!allowPrivateNetworks);
    syncNetworkWhitelist();
  }, [allowPrivateNetworks, setAllowPrivateNetworks]);

  const handleNetworkIsolationToggle = useCallback(() => {
    setNetworkIsolationEnabled(!networkIsolationEnabled);
  }, [networkIsolationEnabled, setNetworkIsolationEnabled]);

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.settings.sandbox} description={copy.sectionDescription} />
      {/* Permission Mode */}
      <SettingGroup>
        <SettingRow title={t.settings.permissionMode} description={t.settings.permissionModeDesc}>
          <PermissionModeSelector />
        </SettingRow>
      </SettingGroup>

      {osSandboxAvailable ? (
        <>
          <SettingGroup>
            {/* Sandbox Toggle */}
            {/* The row has no htmlFor: the label holds the words only, and the info button sits beside it. */}
            <SettingRow
              title={(
                <span className="inline-flex items-center gap-1">
                  <label htmlFor="setting-sandbox">{t.settings.sandboxProtection}</label>
                  <Tooltip
                    content={(
                      <>
                        <p>{copy.tooltipPrimary}</p>
                        <Separator className="my-1" />
                        <p>{copy.tooltipSecondary}</p>
                      </>
                    )}
                  >
                    <Pressable
                      aria-label={t.settings.sandboxProtection}
                      className="inline-flex rounded-control text-label-tertiary hover:text-label"
                    >
                      <Icon icon={AppIcons.info} size="sm" />
                    </Pressable>
                  </Tooltip>
                </span>
              )}
              description={copy.protectionDescription}
            >
              <Switch id="setting-sandbox" checked={sandboxEnabled} onCheckedChange={handleToggle} />
            </SettingRow>

            {/* Network Isolation */}
            {sandboxEnabled && (
              <SettingRow
                htmlFor="setting-network-isolation"
                title={t.settings.networkIsolation}
                description={copy.networkIsolationDescription}
              >
                <Switch
                  id="setting-network-isolation"
                  checked={networkIsolationEnabled}
                  onCheckedChange={handleNetworkIsolationToggle}
                />
              </SettingRow>
            )}

            {/* Network whitelist config */}
            {sandboxEnabled && networkIsolationEnabled && (
              <div className="space-y-3 py-3">
                {/* Private networks toggle */}
                <div className="flex items-center justify-between gap-6">
                  <label htmlFor="setting-private-networks" className="min-w-0 text-ui text-label">
                    {t.settings.allowPrivateNetworks}
                  </label>
                  <Switch
                    id="setting-private-networks"
                    checked={allowPrivateNetworks}
                    onCheckedChange={handlePrivateNetworkToggle}
                  />
                </div>

                <Separator />

                {/* Whitelist entries */}
                <div className="space-y-2">
                  <p className="text-ui text-label">{t.settings.networkWhitelist}</p>

                  {/* Default entries (read-only) */}
                  <div className="space-y-1">
                    <p className={SUBHEADING}>{t.settings.networkPreset}</p>
                    <p className="text-ui-sm text-label-secondary">
                      npm · PyPI · GitHub · GitLab · Anthropic · OpenAI · DeepSeek
                    </p>
                  </div>

                  {/* User entries */}
                  {networkWhitelist.length > 0 && (
                    <div className="space-y-1">
                      <p className={SUBHEADING}>{t.settings.networkCustom}</p>
                      {networkWhitelist.map(domain => (
                        <div key={domain} className="group flex items-center justify-between rounded-control px-2 py-1 hover:bg-fill-hover">
                          <span className="font-code text-ui-sm text-label">{domain}</span>
                          {/* Shown under the pointer and when the keyboard reaches the button. */}
                          <span className="inline-flex opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
                            <IconButton
                              size="sm"
                              icon={AppIcons.close}
                              label={t.common.delete}
                              onClick={() => handleRemoveDomain(domain)}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add new entry */}
                  <div className="flex gap-2">
                    <TextField
                      value={newDomain}
                      onChange={e => setNewDomain(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddDomain()}
                      placeholder="*.company.com / 10.0.0.0/8"
                      className="min-w-0 flex-1 font-code"
                    />
                    <IconButton
                      variant="secondary"
                      icon={AppIcons.add}
                      label={t.settings.add}
                      onClick={handleAddDomain}
                      disabled={!newDomain.trim()}
                    />
                  </div>
                </div>
              </div>
            )}
          </SettingGroup>

          {/* On Windows the app-layer guards ARE the file-path defense (the OS
              sandbox only reduces privileges), so keep the notice Windows
              users always had — macOS conveys paths via the Seatbelt copy. */}
          {windows && <AppLayerProtectionNotice />}
        </>
      ) : (
        <div className="space-y-3">
          <InlineMessage tone="warning">{t.settings.sandboxMacOSOnly}</InlineMessage>
          <AppLayerProtectionNotice />
        </div>
      )}
      {/* Content Guard toggle — Task #26, Module H kill switch.
          Separate from sandbox because it governs content patterns
          (exfiltration, injection, destructive commands) not file-path
          access. Default ON; turning off skips the 120-pattern scan for
          agent-initiated writes (memory + skill drafts). */}
      <ContentGuardToggle />

      {/* Authorized Writable Paths */}
      {sandboxEnabled && (
        <SettingGroup title={t.sandbox.authorizedPaths}>
          <AuthorizedPathsList />
        </SettingGroup>
      )}

      {/* Computer Use: remembered per-app grants and the denied list (L2 §2.4).
          Independent of the shell sandbox — it governs which desktop apps
          Abu may control, not file paths. */}
      <ComputerUseGrantsCard />
    </div>
  );
}

function AppLayerProtectionNotice() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 text-ui-sm text-label-secondary">
      <Icon icon={AppIcons.shield} size="sm" />
      <p>{t.settings.sandboxAppLayerProtection}</p>
    </div>
  );
}

function ContentGuardToggle() {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.safety.enableContentGuard);
  const setEnabled = useSettingsStore((s) => s.setContentGuardEnabled);
  const confirm = useConfirm();

  const handleClick = async () => {
    if (enabled) {
      const confirmed = await confirm({
        title: t.settings.contentGuardDisableTitle,
        message: t.settings.contentGuardDisableMessage,
        confirmLabel: t.common.confirm,
        tone: 'danger',
      });
      // The answer is about scanning as it is now: it may have been turned off while the question was open.
      if (confirmed && useSettingsStore.getState().safety.enableContentGuard) setEnabled(false);
    } else setEnabled(true);
  };

  return (
    <SettingGroup>
      <SettingRow
        htmlFor="setting-content-guard"
        title={(
          // Top-aligned, so the sign does not move the text baseline and the row keeps its height.
          <span className="inline-flex items-center gap-1 align-top">
            {!enabled && <StatusIcon tone="warning" size="sm" />}
            <span>{t.settings.contentGuardTitle}</span>
          </span>
        )}
        description={t.settings.contentGuardDesc}
      >
        <Switch id="setting-content-guard" checked={enabled} onCheckedChange={handleClick} />
      </SettingRow>
    </SettingGroup>
  );
}

// Subscribe to authorized paths changes — uses a version counter
// since getAuthorizedWritablePaths returns a new array each call
let pathsVersion = 0;
const pathsListeners = new Set<() => void>();

function subscribeToAuthorizedPaths(callback: () => void): () => void {
  pathsListeners.add(callback);
  return () => pathsListeners.delete(callback);
}

function notifyPathsChanged(): void {
  pathsVersion++;
  for (const cb of pathsListeners) cb();
}

function AuthorizedPathsList() {
  const { t } = useI18n();
  // Re-render when paths change
  useSyncExternalStore(subscribeToAuthorizedPaths, () => pathsVersion);
  const paths = getAuthorizedWritablePaths();

  if (paths.length === 0) {
    return (
      <p className="py-3 text-ui-sm text-label-tertiary">
        {t.sandbox.authorizedPathsEmpty}
      </p>
    );
  }

  return (
    <>
      {paths.map((path) => (
        <div key={path} className="flex items-center gap-2 py-2">
          <Icon icon={AppIcons.folderOpen} size="sm" className="text-label-tertiary" />
          <span className="min-w-0 flex-1 truncate font-code text-ui-sm text-label-secondary" title={path}>
            {path}
          </span>
          <IconButton
            size="sm"
            icon={AppIcons.delete}
            label={t.sandbox.revoke}
            onClick={() => {
              revokeWorkspace(path);
              notifyPathsChanged();
            }}
          />
        </div>
      ))}
    </>
  );
}

function PermissionModeSelector() {
  const { t } = useI18n();
  const permissionMode = useSettingsStore(s => s.permissionMode);
  const setPermissionMode = useSettingsStore(s => s.setPermissionMode);

  const labels: Record<PermissionMode, { name: string; desc: string }> = {
    standard: { name: t.settings.permissionModeStandard, desc: t.settings.permissionModeStandardDesc },
    smart: { name: t.settings.permissionModeSmart, desc: t.settings.permissionModeSmartDesc },
    autonomous: { name: t.settings.permissionModeAutonomous, desc: t.settings.permissionModeAutonomousDesc },
  };

  return (
    <div className={SETTING_CONTROL_WIDTH.permissionMode}>
      <Select
        fullWidth
        label={t.settings.permissionMode}
        value={permissionMode}
        options={PERMISSION_MODES.map(value => ({
          value,
          label: labels[value].name,
          description: labels[value].desc,
        }))}
        onValueChange={value => setPermissionMode(value as PermissionMode)}
      />
    </div>
  );
}
