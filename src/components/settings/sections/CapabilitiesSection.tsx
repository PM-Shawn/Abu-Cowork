import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Chrome,
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
  SetupHeader,
  settingsCardClass,
} from './CapabilitySetupView';
import {
  BrowserPermissionCards,
  BrowserSitePermissionsPage,
  type BrowserBackend,
} from './BrowserPermissionCards';

/**
 * Where the section is currently pointed. `CapabilitySetupTarget` is only what
 * a RUNNING TASK can ask for ('chrome' | 'computer') and is a persisted store
 * field — it is deliberately NOT widened here. The two extra destinations are
 * user-driven drill-ins with no task counterpart, so they live in local view
 * state only and the store keeps the exact shape it had.
 */
type CapabilityDetailView = CapabilitySetupTarget | 'builtin' | 'sites' | null;


interface CapabilitiesSectionProps {
  setupTarget?: CapabilitySetupTarget;
  requestedByTask?: boolean;
  computerUseRequirements?: ComputerUsePermissionRequirements;
  setupOnly?: boolean;
  onSetupComplete?: () => void;
  onSetupCancel?: () => void;
  onSetupRelaunch?: () => void;
}

/**
 * The only three outcomes a capability card reports. The five runtime status
 * codes collapse onto them because a badge answers "can I use this right now",
 * not "which subsystem failed" — the card's one-line subtitle carries the
 * specific reason, so nothing is lost by not spelling it out twice.
 *
 * `checking` is not a fourth outcome: it is the transient look of a probe in
 * flight, and the badge returns to one of the three as soon as it lands.
 */
type StatusBadgeTone = 'ready' | 'neutral' | 'attention';

function badgeToneFor(code: CapabilityStatusCode): StatusBadgeTone {
  switch (code) {
    case 'ready':
      return 'ready';
    // Nothing to set up — the shell does not offer this capability at all.
    case 'unavailable':
      return 'neutral';
    case 'setup-required':
    case 'permission-required':
    case 'connection-lost':
      return 'attention';
  }
}

function StatusBadge({
  label,
  tone,
  checking = false,
}: {
  label: string;
  tone: StatusBadgeTone;
  checking?: boolean;
}) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-caption font-medium',
      checking
        ? 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]'
        : tone === 'ready'
          ? 'bg-[var(--abu-success-bg)] text-[var(--abu-success)]'
          : tone === 'attention'
            ? 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]'
            : 'bg-[var(--abu-bg-active)] text-[var(--abu-text-muted)]',
    )}>
      {checking && <LoaderCircle className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  );
}

/**
 * A channel on the overview: name, one state, one line, one named button.
 *
 * The ROW IS NOT CLICKABLE and carries no chevron of its own — a chevron on a
 * whole row reads as "expands in place", which is not what happens. The only
 * way onward is the button, and the button says where it goes.
 */
function ChannelCard({
  icon: Icon,
  title,
  subtitle,
  statusLabel,
  statusTone,
  checking = false,
  actionLabel,
  onAction,
  actionDisabled = false,
}: {
  icon: typeof Globe2;
  title: string;
  subtitle: string;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  checking?: boolean;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--abu-bg-base)] text-[var(--abu-clay)]">
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">{title}</h4>
            <StatusBadge label={statusLabel} tone={statusTone} checking={checking} />
          </div>
          <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1.5 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {actionLabel}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
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
  const [setupView, setSetupView] = useState<CapabilityDetailView>(
    setupTarget ?? null,
  );
  // Which channel's detail page the site list was opened from, so "back" lands
  // where the user actually was rather than always on the built-in browser.
  const [sitesOrigin, setSitesOrigin] = useState<BrowserBackend>('builtin');
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

  // Three outcomes, and only three. `unavailable` reads as "not connected"
  // rather than "needs setup" because there is nothing the user could set up;
  // the subtitle underneath says which shell limitation caused it.
  const statusLabels: Record<CapabilityStatusCode, string> = {
    ready: t.settings.capabilityStatusReady,
    'setup-required': t.settings.capabilityStatusSetupRequired,
    'permission-required': t.settings.capabilityStatusSetupRequired,
    'connection-lost': t.settings.capabilityStatusSetupRequired,
    unavailable: t.settings.capabilityStatusNotConnected,
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

  const openBuiltinBrowser = () => {
    setSetupRequestedByTask(false);
    setSetupView('builtin');
  };

  const openSitePermissions = (origin: BrowserBackend) => {
    setSitesOrigin(origin);
    setSetupView('sites');
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

  const browserStatusNote = browserStatus.code === 'unavailable'
    ? t.settings.capabilityBuiltinBrowserUnavailable
    : browserStatus.code === 'connection-lost'
      ? t.settings.capabilityBuiltinBrowserDisconnected
      : t.settings.capabilityBuiltinBrowserScope;

  const chromeChecking_ = chromeChecking || chromeRuntimeChecking;
  // The Chrome bridge is optional and has a "never set up" state that is not a
  // problem, so it reads as not-connected rather than needs-setup.
  const chromeNeverConnected = !chromeBridge
    || !chromeBridgeEnabled
    || chromeStatus.code === 'setup-required';
  const chromeStatusLabel = chromeChecking_
    ? t.settings.capabilityStatusChecking
    : chromeNeverConnected
      ? t.settings.capabilityStatusNotConnected
      : statusLabels[chromeStatus.code];
  const chromeStatusTone: StatusBadgeTone = chromeNeverConnected
    ? 'neutral'
    : badgeToneFor(chromeStatus.code);
  /*
    Never having connected Chrome is not a fault — the badge already says
    "not connected" and the button already says "Connect Chrome", so restating
    it in the subtitle would spend the card's one line on nothing. That line
    goes to what connecting would BUY. A channel that was connected and then
    broke is a different matter, and keeps its diagnosis.
  */
  const chromeSubtitle = chromeChecking_
    ? t.settings.capabilityStatusChecking
    : chromeStatus.code === 'connection-lost'
      ? t.settings.capabilityChromeDisconnected
      : chromeStatus.code === 'unavailable'
        ? t.settings.capabilityChromeProbeUnavailable
        : chromeNeverConnected
          ? t.settings.capabilityMyChromeSubtitle
          : t.settings.capabilityMyChromeScope;

  // Computer Use being switched off is not a fault and not a missing
  // connection; it renders in the neutral tone with its own word for it.
  const computerStatusLabel = computerChecking
    ? t.settings.capabilityStatusChecking
    : !computerUseEnabled
      ? t.settings.capabilityStatusOff
      : statusLabels[computerDisplayStatus.code];
  const computerStatusTone: StatusBadgeTone = !computerUseEnabled
    ? 'neutral'
    : badgeToneFor(computerDisplayStatus.code);

  const overviewLabel = t.settings.capabilityOverview;
  const builtinTrail = [overviewLabel, t.settings.capabilityBuiltinBrowser];
  const chromeTrail = [overviewLabel, t.settings.capabilityMyChrome];
  const computerTrail = [overviewLabel, t.settings.computerUse];
  const sitesTrail = [
    ...(sitesOrigin === 'chrome' ? chromeTrail : builtinTrail),
    t.settings.browserSitePermsTitle,
  ];

  /** Breadcrumb navigation: index 0 is the overview, anything deeper is the
   *  detail page the current page hangs off. */
  const navigateTrail = (origin: BrowserBackend) => (index: number) => {
    if (index === 0) {
      cancelSetup();
      return;
    }
    setSetupView(origin);
  };

  if (setupView === 'sites') {
    return (
      <BrowserSitePermissionsPage
        trail={sitesTrail}
        onNavigate={navigateTrail(sitesOrigin)}
      />
    );
  }

  if (setupView === 'builtin') {
    return (
      <div className="space-y-7">
        <SetupHeader
          icon={Globe2}
          title={t.settings.capabilityBuiltinBrowser}
          description={t.settings.capabilityBuiltinBrowserDesc}
          onBack={cancelSetup}
          breadcrumb={builtinTrail}
        />

        <div className="flex flex-wrap items-center gap-3 border-y border-[var(--abu-border)] py-4">
          <StatusBadge
            label={browserChecking
              ? t.settings.capabilityStatusChecking
              : statusLabels[browserStatus.code]}
            tone={badgeToneFor(browserStatus.code)}
            checking={browserChecking}
          />
          <span className="min-w-0 flex-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
            {browserStatusNote}
          </span>
          {browserStatus.code !== 'ready' && (
            <button
              type="button"
              onClick={handleBrowserRetry}
              disabled={browserChecking || browserStatus.reason === 'unsupported-shell'}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1.5 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', browserChecking && 'animate-spin')} />
              {browserStatus.code === 'connection-lost'
                ? t.settings.capabilityRetry
                : t.settings.capabilityCheckStatus}
            </button>
          )}
        </div>

        <BrowserPermissionCards
          backend="builtin"
          onManageSites={() => openSitePermissions('builtin')}
        />
      </div>
    );
  }

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
        breadcrumb={chromeTrail}
        onBack={cancelSetup}
        onPrepare={prepareChromeBridge}
        onOpenInstaller={openChromeInstaller}
        onCheck={refreshChromeConnection}
        onDone={completeSetup}
        onDisconnect={disconnectChromeBridge}
      >
        <BrowserPermissionCards
          backend="chrome"
          onManageSites={() => openSitePermissions('chrome')}
        />
      </ChromeSetupView>
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
        breadcrumb={computerTrail}
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
      >
        {/*
          The active model decides whether Computer Use can see the screen at
          all, so it belongs beside the permissions it gates rather than on the
          overview, where it was a second status the card had to explain.
        */}
        <div className={settingsCardClass}>
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
      </ComputerUseSetupView>
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
          {/*
            A card shows its standing description while everything is fine, and
            switches to the live note the moment it is not — one line either
            way, and a problem is never hidden behind a marketing sentence.
          */}
          <ChannelCard
            icon={Globe2}
            title={t.settings.capabilityBuiltinBrowser}
            subtitle={browserStatus.code === 'ready'
              ? t.settings.capabilityBuiltinBrowserSubtitle
              : browserStatusNote}
            statusLabel={browserChecking
              ? t.settings.capabilityStatusChecking
              : statusLabels[browserStatus.code]}
            statusTone={badgeToneFor(browserStatus.code)}
            checking={browserChecking}
            actionLabel={t.settings.capabilityManage}
            onAction={openBuiltinBrowser}
          />

          <ChannelCard
            icon={Chrome}
            title={t.settings.capabilityMyChrome}
            subtitle={chromeStatus.code === 'ready' && !chromeChecking_
              ? t.settings.capabilityMyChromeSubtitle
              : chromeSubtitle}
            statusLabel={chromeStatusLabel}
            statusTone={chromeStatusTone}
            checking={chromeChecking_}
            actionLabel={chromeStatus.code === 'ready'
              ? t.settings.capabilityChromeManage
              : t.settings.capabilityChromeConnect}
            onAction={openChromeSetup}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-body font-medium text-[var(--abu-text-secondary)]">
          {t.settings.capabilityComputerTitle}
        </h4>
        <ChannelCard
          icon={MonitorCog}
          title={t.settings.computerUse}
          subtitle={computerUseEnabled && computerDisplayStatus.code === 'ready'
            ? t.settings.capabilityComputerSubtitle
            : computerStatusNote}
          statusLabel={computerStatusLabel}
          statusTone={computerStatusTone}
          checking={computerChecking}
          actionLabel={!computerUseEnabled
            ? t.settings.capabilityComputerStartSetup
            : computerDisplayStatus.code === 'ready'
              ? t.settings.capabilityComputerManage
              : t.settings.capabilityComputerContinue}
          onAction={openComputerSetup}
          actionDisabled={computerChecking}
        />
      </section>

    </div>
  );
}
