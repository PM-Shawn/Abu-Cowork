import { useCallback, useEffect, useRef, useState } from 'react';
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
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useToastStore } from '@/stores/toastStore';
import {
  checkComputerUsePermissions,
  closeComputerUsePermissionGuide,
  requestComputerUsePermission,
  revealComputerUseAppInFinder,
  runComputerUsePermissionGuide,
  type ComputerUsePermission,
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
import {
  ChromeSetupView,
  ComputerUseSetupView,
} from './CapabilitySetupView';

type CapabilitySetupView = CapabilitySetupTarget | null;

interface CapabilitiesSectionProps {
  setupTarget?: CapabilitySetupTarget;
  requestedByTask?: boolean;
  setupOnly?: boolean;
  onSetupComplete?: () => void;
  onSetupCancel?: () => void;
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

export default function CapabilitiesSection({
  setupTarget,
  requestedByTask = false,
  setupOnly = false,
  onSetupComplete,
  onSetupCancel,
}: CapabilitiesSectionProps = {}) {
  const { t } = useI18n();
  const computerUseEnabled = useSettingsStore((state) => state.computerUseEnabled);
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
        strings: {
          title: t.settings.capabilityComputerSetupTitle,
          description: setupRequestedByTask
            ? t.settings.capabilityComputerTaskNeedsSetup
            : t.settings.capabilityComputerSetupDesc,
          screenTitle: t.settings.capabilityScreenRead,
          screenDescription: t.settings.capabilityScreenReadDesc,
          controlTitle: t.settings.capabilityUIControl,
          controlDescription: t.settings.capabilityUIControlDesc,
          screenStep: t.settings.capabilityComputerStepScreen,
          controlStep: t.settings.capabilityComputerStepControl,
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
          privacyNote: t.settings.capabilityComputerPrivacy,
        },
      });
      if (guideResult) {
        setPermissions(guideResult.permissions);
        if (guideResult.status === 'complete') {
          completeSetup();
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

  const computerStatusNote = !computerUseEnabled
    ? t.settings.capabilityComputerDisabled
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
      </section>

      <section className="space-y-3">
        <h4 className="text-body font-medium text-[var(--abu-text-secondary)]">
          {t.settings.capabilityComputerTitle}
        </h4>
        <CapabilityCard
          icon={MonitorCog}
          title={t.settings.computerUse}
          description={t.settings.capabilityComputerDesc}
          status={computerStatus}
          statusLabel={computerChecking
            ? t.settings.capabilityStatusChecking
            : !computerUseEnabled
              ? t.settings.capabilityStatusOff
              : statusLabels[computerStatus.code]}
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
                : computerStatus.code === 'ready'
                  ? t.settings.capabilityComputerManage
                  : t.settings.capabilityComputerContinue}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        >
          <div className="mt-4 grid grid-cols-1 gap-2 border-t border-[var(--abu-border)] pt-3 sm:grid-cols-2">
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
        </CapabilityCard>
      </section>

    </div>
  );
}
