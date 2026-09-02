import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Chrome,
  Circle,
  CircleAlert,
  Eye,
  Globe2,
  LoaderCircle,
  MonitorCog,
  MousePointer2,
  RefreshCw,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  browserOperationStatesFor,
  type BrowserOperationClass,
  type BrowserOperationState,
} from '@/core/permissions/browserToolPolicy';
import { useMCPStore } from '@/stores/mcpStore';
import { useToastStore } from '@/stores/toastStore';
import {
  checkComputerUsePermissions,
  closeComputerUsePermissionGuide,
  requestComputerUsePermission,
  revealComputerUseAppInFinder,
  runComputerUsePermissionGuide,
  type ComputerUsePermission,
  type ComputerUsePermissionRequirements,
  type ComputerUsePermissions,
} from '@/core/agent/computerUsePermission';
import {
  ensureBuiltinBrowserRuntime,
} from '@/core/browser/builtinBrowserRuntime';
import { mcpManager } from '@/core/mcp/client';
import { CAPABILITY_IDS } from '@/core/capabilityPlugins/catalog';
import {
  probeChromeBridgeConnection,
  readCapabilityRuntimeSnapshot,
} from '@/core/capabilityPlugins/runtime';
import { deriveCapabilityStatuses } from '@/core/capabilityPlugins/status';
import type {
  CapabilitySetupTarget,
  CapabilityStatus,
  CapabilityStatusCode,
} from '@/core/capabilityPlugins/types';
import {
  ensureMCPServer,
  resolveMCPCompanionResource,
} from '@/core/agent/mcpDiscovery';
import { openBundledChromeExtensionSetup } from '@/core/capabilityPlugins/chromeSetup';
import { isMacOS } from '@/utils/platform';
import { resolveAgentModelCapabilities } from '@/core/llm/modelCapabilities';
import { resolveModelDeclared } from '@/core/llm/resolveModelDeclared';
import {
  ChromeSetupView,
  ComputerUseSetupView,
} from './CapabilitySetupView';

type CapabilitySetupView = CapabilitySetupTarget | null;

interface CapabilitiesSectionProps {
  setupTarget?: CapabilitySetupTarget;
  requestedByTask?: boolean;
  computerUseRequirements?: ComputerUsePermissionRequirements;
  setupOnly?: boolean;
  onSetupComplete?: () => void;
  onSetupCancel?: () => void;
  onSetupRelaunch?: () => void;
}

type CapabilityCardProps = {
  icon: typeof Globe2;
  title: string;
  description: string;
  status: CapabilityStatus;
  statusLabel: string;
  statusNote: string;
  checking?: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
};

function statusTone(code: CapabilityStatusCode): string {
  switch (code) {
    case 'ready':
      return 'bg-[var(--abu-success-bg)] text-[var(--abu-success)]';
    case 'setup-required':
      return 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]';
    case 'permission-required':
    case 'connection-lost':
      return 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]';
    case 'unavailable':
      return 'bg-[var(--abu-danger-bg)] text-[var(--abu-danger)]';
  }
}

function CapabilityCard({
  icon: Icon,
  title,
  description,
  status,
  statusLabel,
  statusNote,
  checking = false,
  action,
  children,
}: CapabilityCardProps) {
  return (
    <div className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--abu-bg-base)] text-[var(--abu-clay)]">
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">{title}</h4>
            <span className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-0.5 text-caption font-medium',
              checking
                ? 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]'
                : statusTone(status.code),
            )}>
              {checking && <LoaderCircle className="h-3 w-3 animate-spin" />}
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {children}

      <div className="mt-3 flex items-start gap-2 border-t border-[var(--abu-border)] pt-3 text-minor text-[var(--abu-text-tertiary)]">
        {status.code === 'ready'
          ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-success)]" />
          : status.code === 'setup-required'
            ? <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
            : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-warning)]" />}
        <span>{statusNote}</span>
      </div>
    </div>
  );
}

/**
 * Persistent per-site browser-automation verdicts, written from the
 * confirmation dialog ("always allow this site" / "block this site"). Listed
 * here so every standing verdict is visible, switchable between allow and
 * block, and removable — removing restores ask-every-time for that site.
 */
function BrowserSitePermissionsList() {
  const { t } = useI18n();
  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  const setBrowserSitePermission = useSettingsStore((s) => s.setBrowserSitePermission);
  const removeBrowserSitePermission = useSettingsStore((s) => s.removeBrowserSitePermission);
  const origins = Object.keys(sitePermissions).sort();
  const verdictOptions = [
    { value: 'allowed', label: t.settings.browserSitePermsAllowed },
    { value: 'denied', label: t.settings.browserSitePermsDenied },
  ];

  return (
    <div className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
      <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
        {t.settings.browserSitePermsTitle}
      </h4>
      <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {t.settings.browserSitePermsDesc}
      </p>
      {origins.length === 0 ? (
        <p className="mt-3 border-t border-[var(--abu-border)] pt-3 text-minor text-[var(--abu-text-tertiary)]">
          {t.settings.browserSitePermsEmpty}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--abu-border)] border-t border-[var(--abu-border)]">
          {origins.map((origin) => (
            <li key={origin} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-body text-[var(--abu-text-secondary)]" title={origin}>
                {origin}
              </span>
              <Select
                variant="inline"
                value={sitePermissions[origin]}
                options={verdictOptions}
                onChange={(v) => setBrowserSitePermission(origin, v as 'allowed' | 'denied')}
                className={cn(
                  'shrink-0',
                  sitePermissions[origin] === 'allowed'
                    ? 'text-[var(--abu-success)]'
                    : 'text-[var(--abu-danger)]',
                )}
              />
              <button
                type="button"
                onClick={() => removeBrowserSitePermission(origin)}
                className="shrink-0 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)]"
              >
                {t.settings.browserSitePermsRevoke}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The operation-class policy: three rows (read-only / interaction &
 * navigation / scripting) × two columns (attended / unattended), plus the
 * master switch that turns the whole unattended browser surface off.
 *
 * The master switch is above the grid because it OVERRIDES it — with the
 * switch off, no unattended cell can allow anything, and the grid's unattended
 * column is disabled to say so rather than showing settings that do nothing.
 */
function BrowserOperationPolicySection() {
  const { t } = useI18n();
  const policy = useSettingsStore((s) => s.browserOperationPolicy);
  const allowUnattended = useSettingsStore((s) => s.allowUnattendedBrowser);
  const setBrowserOperationState = useSettingsStore((s) => s.setBrowserOperationState);
  const setAllowUnattendedBrowser = useSettingsStore((s) => s.setAllowUnattendedBrowser);

  const stateLabels: Record<BrowserOperationState, string> = {
    allow: t.settings.browserOpStateAllow,
    ask: t.settings.browserOpStateAsk,
    deny: t.settings.browserOpStateDeny,
  };
  // The option list is asked for per cell, not shared: unattended scripting
  // offers no "allow" (see `browserOperationStatesFor`), and offering one the
  // gate would refuse to honor is worse than offering fewer.
  const optionsFor = (runMode: 'attended' | 'unattended', opClass: BrowserOperationClass) =>
    browserOperationStatesFor(runMode, opClass).map((state) => ({
      value: state,
      label: stateLabels[state],
    }));
  const rows: Array<{
    key: 'readOnly' | 'interactive' | 'scripting';
    opClass: BrowserOperationClass;
    label: string;
  }> = [
    { key: 'readOnly', opClass: 'read-only', label: t.settings.browserOpClassReadOnly },
    { key: 'interactive', opClass: 'interactive', label: t.settings.browserOpClassInteractive },
    { key: 'scripting', opClass: 'scripting', label: t.settings.browserOpClassScripting },
  ];

  return (
    <div className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
      <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
        {t.settings.browserOpPolicyTitle}
      </h4>
      <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {t.settings.browserOpPolicyDesc}
      </p>

      <div className="mt-3 flex items-start gap-3 border-t border-[var(--abu-border)] pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-body text-[var(--abu-text-secondary)]">
            {t.settings.browserUnattendedMasterSwitchLabel}
          </p>
          <p className="mt-0.5 text-minor leading-relaxed text-[var(--abu-text-muted)]">
            {t.settings.browserUnattendedMasterSwitchDesc}
          </p>
        </div>
        <Toggle
          checked={allowUnattended}
          onChange={() => setAllowUnattendedBrowser(!allowUnattended)}
          size="lg"
          className="mt-0.5 shrink-0"
        />
      </div>

      <div className="mt-3 border-t border-[var(--abu-border)] pt-3">
        <div className="flex items-center gap-3 pb-1">
          <span className="min-w-0 flex-1" />
          <span className="w-28 shrink-0 text-center text-minor text-[var(--abu-text-muted)]">
            {t.settings.browserOpPolicyColumnAttended}
          </span>
          <span className="w-28 shrink-0 text-center text-minor text-[var(--abu-text-muted)]">
            {t.settings.browserOpPolicyColumnUnattended}
          </span>
        </div>
        <ul className="divide-y divide-[var(--abu-border)]">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-body text-[var(--abu-text-secondary)]">
                {row.label}
              </span>
              <Select
                variant="inline"
                value={policy.attended[row.key]}
                options={optionsFor('attended', row.opClass)}
                onChange={(v) => setBrowserOperationState('attended', row.key, v as 'allow' | 'deny' | 'ask')}
                className="w-28 shrink-0 justify-center"
              />
              <Select
                variant="inline"
                value={policy.unattended[row.key]}
                options={optionsFor('unattended', row.opClass)}
                onChange={(v) => setBrowserOperationState('unattended', row.key, v as 'allow' | 'deny' | 'ask')}
                disabled={!allowUnattended}
                className={cn('w-28 shrink-0 justify-center', !allowUnattended && 'opacity-50')}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function CapabilitiesSection({
  setupTarget,
  requestedByTask = false,
  computerUseRequirements,
  setupOnly = false,
  onSetupComplete,
  onSetupCancel,
  onSetupRelaunch,
}: CapabilitiesSectionProps = {}) {
  const { t } = useI18n();
  const computerUseEnabled = useSettingsStore((state) => state.computerUseEnabled);
  const activeModel = useSettingsStore((state) => state.activeModel);
  const providers = useSettingsStore((state) => state.providers);
  const setComputerUseEnabled = useSettingsStore((state) => state.setComputerUseEnabled);
  const closeSystemSettings = useSettingsStore((state) => state.closeSystemSettings);
  const capabilitySetupTarget = useSettingsStore((state) => state.capabilitySetupTarget);
  const clearCapabilitySetupTarget = useSettingsStore(
    (state) => state.clearCapabilitySetupTarget,
  );
  const chromeBridge = useMCPStore(
    (state) => state.servers[CAPABILITY_IDS.chromeBridge],
  );
  const updateMCPServer = useMCPStore((state) => state.updateServer);
  const disconnectMCPServer = useMCPStore((state) => state.disconnectServer);
  const chromeBridgeEnabled = chromeBridge?.config.enabled ?? true;
  const chromeBridgeStatus = chromeBridge?.status;
  const chromeRuntimeChecking = (
    chromeBridgeStatus === 'connecting' || chromeBridgeStatus === 'reconnecting'
  );

  const [permissions, setPermissions] = useState<ComputerUsePermissions>();
  const [browserChecking, setBrowserChecking] = useState(false);
  const [chromeChecking, setChromeChecking] = useState(false);
  const [chromeExtensionConnected, setChromeExtensionConnected] = useState<boolean>();
  const [computerChecking, setComputerChecking] = useState(false);
  const [setupView, setSetupView] = useState<CapabilitySetupView>(
    setupTarget ?? null,
  );
  const [setupRequestedByTask, setSetupRequestedByTask] =
    useState(requestedByTask);
  const [chromeSetupWorking, setChromeSetupWorking] = useState(false);
  const [chromeInstallerOpening, setChromeInstallerOpening] = useState(false);
  const [chromeExtensionPath, setChromeExtensionPath] = useState<string | null>();
  const [chromeSetupError, setChromeSetupError] = useState<string>();
  const [requestingComputerPermission, setRequestingComputerPermission] =
    useState<ComputerUsePermission>();
  const [revealingComputerUseApp, setRevealingComputerUseApp] = useState(false);
  const computerPermissionCheckRef =
    useRef<Promise<ComputerUsePermissions | undefined> | null>(null);
  const computerPermissionGuideOpenRef = useRef(false);
  const [, setRuntimeRevision] = useState(0);
  const activeProvider = providers.find((provider) => provider.id === activeModel.providerId);
  const computerModelCapabilities = useMemo(() => resolveAgentModelCapabilities({
    modelId: activeModel.modelId,
    providerSource: activeProvider?.source,
    declared: resolveModelDeclared(activeProvider, activeModel.modelId),
  }), [activeModel.modelId, activeProvider]);
  const singleComputerPermissionRequired = Boolean(
    computerUseRequirements
    && Number(computerUseRequirements.screenRead)
      + Number(computerUseRequirements.uiControl) === 1,
  );

  useEffect(() => mcpManager.subscribe(() => {
    setRuntimeRevision((revision) => revision + 1);
  }), []);

  useEffect(() => {
    if (!chromeBridge || !chromeBridgeEnabled || chromeBridgeStatus !== 'connected') {
      setChromeExtensionConnected(undefined);
      setChromeChecking(false);
      return;
    }

    let active = true;
    setChromeChecking(true);
    void probeChromeBridgeConnection().then((connected) => {
      if (!active) return;
      setChromeExtensionConnected(connected);
      setChromeChecking(false);
    });
    return () => {
      active = false;
    };
  }, [chromeBridge, chromeBridgeEnabled, chromeBridgeStatus]);

  const statuses = deriveCapabilityStatuses(
    readCapabilityRuntimeSnapshot({
      chromeBridge: chromeBridge
        ? {
            enabled: chromeBridge.config.enabled ?? true,
            status: chromeBridge.status,
            extensionConnected: chromeExtensionConnected,
          }
        : undefined,
      computerUseEnabled,
      computerUsePermissions: permissions,
    }),
  );

  const statusLabels: Record<CapabilityStatusCode, string> = {
    ready: t.settings.capabilityStatusReady,
    'setup-required': t.settings.capabilityStatusSetupRequired,
    'permission-required': t.settings.capabilityStatusPermissionRequired,
    'connection-lost': t.settings.capabilityStatusConnectionLost,
    unavailable: t.settings.capabilityStatusUnavailable,
  };

  const handleBrowserRetry = async () => {
    setBrowserChecking(true);
    const ready = await ensureBuiltinBrowserRuntime();
    setRuntimeRevision((revision) => revision + 1);
    setBrowserChecking(false);
    if (!ready) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.capabilityStatusUnavailable,
        message: t.settings.capabilityBuiltinBrowserDisconnected,
      });
    }
  };

  const syncComputerPermissions = useCallback(async (showActivity = true) => {
    if (showActivity) setComputerChecking(true);
    let check = computerPermissionCheckRef.current;
    if (!check) {
      check = checkComputerUsePermissions();
      computerPermissionCheckRef.current = check;
    }
    try {
      const nextPermissions = await check;
      setPermissions((current) => (
        current?.screenRead === nextPermissions?.screenRead
        && current?.uiControl === nextPermissions?.uiControl
        && current?.screenReadStatus === nextPermissions?.screenReadStatus
        && current?.uiControlStatus === nextPermissions?.uiControlStatus
        && current?.restartRequired === nextPermissions?.restartRequired
          ? current
          : nextPermissions
      ));
      return nextPermissions;
    } finally {
      if (computerPermissionCheckRef.current === check) {
        computerPermissionCheckRef.current = null;
      }
      if (showActivity) setComputerChecking(false);
    }
  }, []);

  useEffect(() => {
    void syncComputerPermissions();
  }, [syncComputerPermissions]);

  const refreshChromeConnection = async () => {
    setChromeChecking(true);
    const connected = await probeChromeBridgeConnection();
    setChromeExtensionConnected(connected);
    setChromeChecking(false);
  };

  const prepareChromeBridge = useCallback(async () => {
    setChromeSetupWorking(true);
    setChromeSetupError(undefined);
    try {
      if (chromeBridge && !chromeBridgeEnabled) {
        updateMCPServer(CAPABILITY_IDS.chromeBridge, { enabled: true });
      }
      const result = await ensureMCPServer(CAPABILITY_IDS.chromeBridge);
      setChromeExtensionPath(result.extensionPath);
      if (result.status === 'failed' || result.status === 'needs_config') {
        setChromeSetupError(result.message);
        return;
      }
      const connected = await probeChromeBridgeConnection();
      setChromeExtensionConnected(connected);
    } catch (error) {
      setChromeSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChromeSetupWorking(false);
    }
  }, [chromeBridge, chromeBridgeEnabled, updateMCPServer]);

  const disconnectChromeBridge = useCallback(async () => {
    setChromeSetupWorking(true);
    setChromeSetupError(undefined);
    updateMCPServer(CAPABILITY_IDS.chromeBridge, { enabled: false });
    try {
      await disconnectMCPServer(CAPABILITY_IDS.chromeBridge);
      setChromeExtensionConnected(undefined);
    } catch (error) {
      setChromeSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChromeSetupWorking(false);
    }
  }, [disconnectMCPServer, updateMCPServer]);

  const openChromeSetup = () => {
    setSetupRequestedByTask(false);
    setSetupView('chrome');
    setChromeSetupError(undefined);
    void resolveMCPCompanionResource(CAPABILITY_IDS.chromeBridge)
      .then(setChromeExtensionPath)
      .catch(() => setChromeExtensionPath(null));
    void prepareChromeBridge();
  };

  const openChromeInstaller = async () => {
    if (!chromeExtensionPath) return;
    setChromeInstallerOpening(true);
    setChromeSetupError(undefined);
    const result = await openBundledChromeExtensionSetup(chromeExtensionPath);
    setChromeInstallerOpening(false);
    if (!result.extensionFolderOpened || !result.extensionsPageOpened) {
      useToastStore.getState().addToast({
        type: 'warning',
        title: t.settings.capabilityChromeSetupTitle,
        message: t.settings.capabilityChromeOpenFailed,
      });
    }
    void refreshChromeConnection();
  };

  const openComputerSetup = () => {
    setSetupRequestedByTask(false);
    setSetupView('computer');
    void syncComputerPermissions();
  };

  useEffect(() => {
    if (!setupTarget) return;
    setSetupRequestedByTask(requestedByTask);
    setSetupView(setupTarget);
    if (setupTarget === 'chrome') {
      setChromeSetupError(undefined);
      void resolveMCPCompanionResource(CAPABILITY_IDS.chromeBridge)
        .then(setChromeExtensionPath)
        .catch(() => setChromeExtensionPath(null));
    } else {
      void syncComputerPermissions();
    }
  }, [requestedByTask, setupTarget, syncComputerPermissions]);

  useEffect(() => {
    if (setupTarget || !capabilitySetupTarget) return;
    setSetupRequestedByTask(true);
    setSetupView(capabilitySetupTarget);
    clearCapabilitySetupTarget();

    if (capabilitySetupTarget === 'chrome') {
      setChromeSetupError(undefined);
      void resolveMCPCompanionResource(CAPABILITY_IDS.chromeBridge)
        .then(setChromeExtensionPath)
        .catch(() => setChromeExtensionPath(null));
    } else {
      void syncComputerPermissions();
    }
  }, [
    capabilitySetupTarget,
    clearCapabilitySetupTarget,
    prepareChromeBridge,
    setupTarget,
    syncComputerPermissions,
  ]);

  const cancelSetup = () => {
    setSetupRequestedByTask(false);
    if (setupOnly) {
      onSetupCancel?.();
      return;
    }
    setSetupView(null);
  };

  const completeSetup = () => {
    if (setupOnly) {
      onSetupComplete?.();
    } else if (setupRequestedByTask) {
      closeSystemSettings();
    } else {
      setSetupView(null);
    }
    setSetupRequestedByTask(false);
  };

  const handleRequestComputerPermission = async (
    permission: ComputerUsePermission,
  ) => {
    setRequestingComputerPermission(permission);
    try {
      computerPermissionGuideOpenRef.current = true;
      const guideResult = await runComputerUsePermissionGuide({
        requestedByTask: setupRequestedByTask,
        permissions,
        requirements: computerUseRequirements,
        strings: {
          title: t.settings.capabilityComputerSetupTitle,
          description: setupRequestedByTask
            ? t.settings.capabilityComputerTaskNeedsSetup
            : t.settings.capabilityComputerSetupDesc,
          screenTitle: t.settings.capabilityScreenRead,
          screenDescription: t.settings.capabilityScreenReadDesc,
          controlTitle: t.settings.capabilityUIControl,
          controlDescription: t.settings.capabilityUIControlDesc,
          screenStep: singleComputerPermissionRequired
            ? t.settings.capabilityComputerStepOnly
            : t.settings.capabilityComputerStepScreen,
          controlStep: singleComputerPermissionRequired
            ? t.settings.capabilityComputerStepOnly
            : t.settings.capabilityComputerStepControl,
          allow: t.settings.capabilityPermissionGuideAllow,
          done: t.settings.capabilityPermissionGuideDone,
          checking: t.settings.capabilityStatusChecking,
          cancel: t.common.cancel,
          returnToAbu: setupRequestedByTask
            ? t.settings.capabilityReturnToTask
            : t.settings.capabilityPermissionGuideReturnToAbu,
          missingApp: t.settings.capabilityComputerMissingApp,
          revealApp: t.settings.capabilityShowAppInFinder,
          developmentIdentity:
            t.settings.capabilityPermissionGuideDevelopmentIdentity,
          errorTitle: t.settings.capabilityPermissionGuideErrorTitle,
          retry: t.settings.capabilityRetry,
          timeout: t.settings.capabilityPermissionGuideTimeout,
          restart: t.settings.capabilityPermissionGuideRestart,
          privacyNote: t.settings.capabilityComputerPrivacy,
        },
      });
      if (guideResult) {
        setPermissions((current) => ({
          screenRead: guideResult.permissions.screenRead,
          uiControl: guideResult.permissions.uiControl,
          screenReadStatus: current?.screenReadStatus
            ?? (guideResult.permissions.screenRead ? 'granted' : 'not-determined'),
          uiControlStatus: current?.uiControlStatus
            ?? (guideResult.permissions.uiControl ? 'granted' : 'not-determined'),
          restartRequired: guideResult.permissions.restartRequired === true,
        }));
        if (guideResult.status === 'complete') {
          completeSetup();
        } else if (guideResult.status === 'relaunch-required' && onSetupRelaunch) {
          onSetupRelaunch();
        } else if (guideResult.status === 'cancelled' && setupRequestedByTask) {
          cancelSetup();
        } else if (guideResult.status === 'unavailable') {
          useToastStore.getState().addToast({
            type: 'error',
            title: t.settings.capabilityStatusUnavailable,
            message: guideResult.error
              ?? t.settings.capabilityPermissionGuideErrorTitle,
          });
        }
        return;
      }

      await requestComputerUsePermission(permission);
      await syncComputerPermissions(false);
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.capabilityStatusUnavailable,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      computerPermissionGuideOpenRef.current = false;
      setRequestingComputerPermission(undefined);
    }
  };

  const handleRevealComputerUseApp = async () => {
    setRevealingComputerUseApp(true);
    try {
      const revealed = await revealComputerUseAppInFinder();
      if (!revealed) {
        useToastStore.getState().addToast({
          type: 'warning',
          title: t.settings.capabilityComputerSetupTitle,
          message: t.settings.capabilityComputerRevealFailed,
        });
      }
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.capabilityComputerSetupTitle,
        message: error instanceof Error
          ? error.message
          : t.settings.capabilityComputerRevealFailed,
      });
    } finally {
      setRevealingComputerUseApp(false);
    }
  };

  useEffect(() => {
    if (
      setupView !== 'chrome'
      || !chromeBridgeEnabled
      || chromeBridgeStatus !== 'connected'
      || chromeExtensionConnected
    ) {
      return;
    }
    const poll = window.setInterval(() => {
      void probeChromeBridgeConnection().then((connected) => {
        if (connected !== undefined) setChromeExtensionConnected(connected);
      });
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [chromeBridgeEnabled, chromeBridgeStatus, chromeExtensionConnected, setupView]);

  useEffect(() => {
    if (setupView !== 'computer') return;
    const refresh = () => void syncComputerPermissions(false);
    window.addEventListener('focus', refresh);
    const poll = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(poll);
    };
  }, [setupView, syncComputerPermissions]);

  useEffect(() => {
    if (setupView === 'computer') return;
    if (computerPermissionGuideOpenRef.current) {
      void closeComputerUsePermissionGuide();
    }
  }, [setupView]);

  useEffect(() => () => {
    if (computerPermissionGuideOpenRef.current) {
      void closeComputerUsePermissionGuide();
    }
  }, []);

  const browserStatus = statuses[CAPABILITY_IDS.builtinBrowser];
  const chromeStatus = statuses[CAPABILITY_IDS.chromeBridge];
  const computerStatus = statuses[CAPABILITY_IDS.computerUse];
  const screenPermission = permissions?.screenRead;
  const controlPermission = permissions?.uiControl;
  const computerModelTierLabels = {
    full: t.settings.capabilityComputerModelFull,
    structured: t.settings.capabilityComputerModelStructured,
    unsupported: t.settings.capabilityComputerModelUnsupported,
    unknown: t.settings.capabilityComputerModelUnknown,
  } as const;
  const computerModelTierNotes = {
    full: t.settings.capabilityComputerModelFullNote,
    structured: t.settings.capabilityComputerModelStructuredNote,
    unsupported: t.settings.capabilityComputerModelUnsupportedNote,
    unknown: t.settings.capabilityComputerModelUnknownNote,
  } as const;
  const computerDisplayStatus: CapabilityStatus = computerUseEnabled
    && computerModelCapabilities.computerUseTier === 'unsupported'
    ? { ...computerStatus, code: 'unavailable', reason: 'probe-unavailable' }
    : computerUseEnabled && computerModelCapabilities.computerUseTier === 'unknown'
      ? { ...computerStatus, code: 'setup-required', reason: 'not-configured' }
      : computerStatus;

  const computerStatusNote = !computerUseEnabled
    ? t.settings.capabilityComputerDisabled
    : computerModelCapabilities.computerUseTier === 'unsupported'
      || computerModelCapabilities.computerUseTier === 'unknown'
      ? computerModelTierNotes[computerModelCapabilities.computerUseTier]
      : screenPermission && !controlPermission
        ? t.settings.capabilityComputerPartial
        : computerStatus.code === 'permission-required'
          ? t.settings.capabilityComputerPermissionMissing
          : t.settings.capabilityComputerDesc;

  if (setupView === 'chrome') {
    return (
      <ChromeSetupView
        capabilityEnabled={Boolean(chromeBridge && chromeBridgeEnabled)}
        requestedByTask={setupRequestedByTask}
        runtimeReady={chromeBridgeEnabled && chromeBridgeStatus === 'connected'}
        extensionConnected={chromeExtensionConnected === true}
        extensionPath={chromeExtensionPath}
        working={chromeSetupWorking || chromeChecking || chromeRuntimeChecking}
        openingInstaller={chromeInstallerOpening}
        error={chromeSetupError}
        onBack={cancelSetup}
        onPrepare={prepareChromeBridge}
        onOpenInstaller={openChromeInstaller}
        onCheck={refreshChromeConnection}
        onDone={completeSetup}
        onDisconnect={disconnectChromeBridge}
      />
    );
  }

  if (setupView === 'computer') {
    return (
      <ComputerUseSetupView
        enabled={computerUseEnabled}
        requestedByTask={setupRequestedByTask}
        requirements={computerUseRequirements}
        permissions={permissions}
        checking={computerChecking}
        requesting={requestingComputerPermission}
        revealingApp={revealingComputerUseApp}
        canOpenSystemSettings={isMacOS()}
        onBack={cancelSetup}
        onEnable={() => {
          setComputerUseEnabled(true);
          void syncComputerPermissions();
        }}
        onRequestPermission={handleRequestComputerPermission}
        onRevealApp={handleRevealComputerUseApp}
        onRefresh={() => void syncComputerPermissions()}
        onDisable={() => {
          setComputerUseEnabled(false);
          cancelSetup();
        }}
        onDone={completeSetup}
        onRelaunch={onSetupRelaunch}
      />
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSectionHeader
        title={t.settings.capabilityOverview}
        description={t.settings.capabilitiesDescription}
      />

      <section className="space-y-3">
        <h4 className="text-body font-medium text-[var(--abu-text-secondary)]">
          {t.settings.capabilityWebTitle}
        </h4>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <CapabilityCard
            icon={Globe2}
            title={t.settings.capabilityBuiltinBrowser}
            description={t.settings.capabilityBuiltinBrowserDesc}
            status={browserStatus}
            statusLabel={browserChecking
              ? t.settings.capabilityStatusChecking
              : statusLabels[browserStatus.code]}
            statusNote={browserStatus.code === 'unavailable'
              ? t.settings.capabilityBuiltinBrowserUnavailable
              : browserStatus.code === 'connection-lost'
                ? t.settings.capabilityBuiltinBrowserDisconnected
                : t.settings.capabilityBuiltinBrowserScope}
            checking={browserChecking}
            action={browserStatus.code !== 'ready' ? (
              <button
                type="button"
                onClick={handleBrowserRetry}
                disabled={browserChecking || browserStatus.reason === 'unsupported-shell'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1.5 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', browserChecking && 'animate-spin')} />
                {browserStatus.code === 'connection-lost'
                  ? t.settings.capabilityRetry
                  : t.settings.capabilityCheckStatus}
              </button>
            ) : undefined}
          />

          <CapabilityCard
            icon={Chrome}
            title={t.settings.capabilityMyChrome}
            description={t.settings.capabilityMyChromeDesc}
            status={chromeStatus}
            statusLabel={chromeChecking || chromeRuntimeChecking
              ? t.settings.capabilityStatusChecking
              : !chromeBridge
                || !chromeBridgeEnabled
                || chromeStatus.code === 'setup-required'
                ? t.settings.capabilityStatusNotConnected
                : statusLabels[chromeStatus.code]}
            statusNote={chromeChecking || chromeRuntimeChecking
              ? t.settings.capabilityStatusChecking
              : !chromeBridge || !chromeBridgeEnabled
                ? t.settings.capabilityChromeOptional
                : chromeStatus.code === 'setup-required'
                  ? t.settings.capabilityChromeSetupRequired
              : chromeStatus.code === 'connection-lost'
                ? t.settings.capabilityChromeDisconnected
                : chromeStatus.code === 'unavailable'
                  ? t.settings.capabilityChromeProbeUnavailable
                : t.settings.capabilityMyChromeScope}
            checking={chromeChecking || chromeRuntimeChecking}
            action={(
              <button
                type="button"
                onClick={openChromeSetup}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1.5 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)]"
              >
                {chromeStatus.code === 'ready'
                  ? t.settings.capabilityChromeManage
                  : t.settings.capabilityChromeConnect}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          >
            {chromeBridgeStatus === 'connected' && (
              <button
                type="button"
                onClick={refreshChromeConnection}
                disabled={chromeChecking || chromeRuntimeChecking}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg text-minor font-medium text-[var(--abu-info)] transition-colors hover:text-[var(--abu-info)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', chromeChecking && 'animate-spin')} />
                {t.settings.capabilityCheckStatus}
              </button>
            )}
          </CapabilityCard>
        </div>

        <BrowserOperationPolicySection />
        <BrowserSitePermissionsList />
      </section>

      <section className="space-y-3">
        <h4 className="text-body font-medium text-[var(--abu-text-secondary)]">
          {t.settings.capabilityComputerTitle}
        </h4>
        <CapabilityCard
          icon={MonitorCog}
          title={t.settings.computerUse}
          description={t.settings.capabilityComputerDesc}
          status={computerDisplayStatus}
          statusLabel={computerChecking
            ? t.settings.capabilityStatusChecking
            : !computerUseEnabled
              ? t.settings.capabilityStatusOff
              : statusLabels[computerDisplayStatus.code]}
          statusNote={computerStatusNote}
          checking={computerChecking}
          action={(
            <button
              type="button"
              onClick={openComputerSetup}
              disabled={computerChecking}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1.5 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] disabled:opacity-50"
            >
              {!computerUseEnabled
                ? t.settings.capabilityComputerStartSetup
                : computerDisplayStatus.code === 'ready'
                  ? t.settings.capabilityComputerManage
                  : t.settings.capabilityComputerContinue}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        >
          <div className="mt-4 border-t border-[var(--abu-border)] pt-3">
            <div className="flex items-start gap-2">
              <MonitorCog className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-minor text-[var(--abu-text-secondary)]">
                    {t.settings.capabilityComputerModel}
                  </span>
                  <span className={cn(
                    'text-caption font-medium',
                    computerModelCapabilities.computerUseTier === 'full' && 'text-[var(--abu-success)]',
                    computerModelCapabilities.computerUseTier === 'structured' && 'text-[var(--abu-warning)]',
                    computerModelCapabilities.computerUseTier === 'unsupported' && 'text-[var(--abu-danger)]',
                    computerModelCapabilities.computerUseTier === 'unknown' && 'text-[var(--abu-text-muted)]',
                  )}>
                    {activeModel.modelId || t.settings.capabilityComputerModelUnknown}
                    {' · '}
                    {computerModelTierLabels[computerModelCapabilities.computerUseTier]}
                  </span>
                </div>
                <p className="mt-1 text-caption text-[var(--abu-text-tertiary)]">
                  {computerModelTierNotes[computerModelCapabilities.computerUseTier]}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-[var(--abu-border)] pt-3 sm:grid-cols-2">
              {([
              {
                icon: Eye,
                label: t.settings.capabilityScreenRead,
                granted: screenPermission,
              },
              {
                icon: MousePointer2,
                label: t.settings.capabilityUIControl,
                granted: controlPermission,
              },
              ] as const).map(({ icon: PermissionIcon, label, granted }) => (
                <div key={label} className="flex items-center gap-2">
                  <PermissionIcon className="h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
                  <span className="text-minor text-[var(--abu-text-secondary)]">{label}</span>
                  <span className={cn(
                    'ml-auto text-caption font-medium',
                    granted === true && 'text-[var(--abu-success)]',
                    granted === false && 'text-[var(--abu-warning)]',
                    granted === undefined && 'text-[var(--abu-text-muted)]',
                  )}>
                    {granted === true
                      ? t.settings.capabilityPermissionGranted
                      : granted === false
                        ? t.settings.capabilityPermissionMissing
                        : t.settings.capabilityPermissionUnknown}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CapabilityCard>
      </section>

    </div>
  );
}
