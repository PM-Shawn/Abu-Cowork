import { BrowserDownloadHistoryEntry, BrowserDownloadHistoryPage } from './BrowserDownloadHistoryPage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { Disclosure } from '@/components/ds/disclosure';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Pressable } from '@/components/ds/pressable';
import { StatusIcon } from '@/components/ds/status-icon';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useToastStore } from '@/stores/toastStore';
import {
  checkComputerUsePermissions,
  requestComputerUsePermission,
  revealComputerUseAppInFinder,
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
import {
  hasChromeExtensionHandshaked,
  setChromeExtensionHandshaked,
} from '@/core/capabilityPlugins/chromeHandshakeLatch';
import type {
  CapabilitySetupTarget,
  CapabilityStatus,
  CapabilityStatusCode,
} from '@/core/capabilityPlugins/types';
import {
  ensureMCPServer,
  resolveMCPCompanionResource,
} from '@/core/agent/mcpDiscovery';
import { getChromeExtensionInstallation, type ChromeExtensionInstallation, openBundledChromeExtensionSetup } from '@/core/capabilityPlugins/chromeSetup';
import { restartApp } from '@/core/updates/checker';
import { isMacOS } from '@/utils/platform';
import { resolveAgentModelCapabilities } from '@/core/llm/modelCapabilities';
import { resolveModelDeclared } from '@/core/llm/resolveModelDeclared';
import {
  CapabilityStatusRow,
  ChromeSetupView,
  ComputerUseSetupView,
  SetupHeader,
  StatusBadge,
  type StatusBadgeTone,
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
type CapabilityDetailView = CapabilitySetupTarget | 'builtin' | 'sites' | 'downloads' | null;


interface CapabilitiesSectionProps {
  setupTarget?: CapabilitySetupTarget;
  requestedByTask?: boolean;
  computerUseRequirements?: ComputerUsePermissionRequirements;
  setupOnly?: boolean;
  onSetupComplete?: () => void;
  onSetupCancel?: () => void;
  onSetupRelaunch?: () => void;
}

/** The overview card's badge tone. See `StatusBadgeTone` for why there are
 *  only three of them for five runtime status codes. */
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

/**
 * A channel on the overview: name, one state, one line, and a chevron.
 *
 * The ENTIRE ROW is the control — one target, one affordance, and the chevron
 * is the only thing claiming anything is clickable. An earlier revision put a
 * named button on the right of each card instead; the user's call is that
 * three cards each carrying a differently-worded button is three decisions to
 * read where there is really only one. Connecting Chrome is not lost — it
 * lives on the page this row opens.
 */
function ChannelCard({
  icon,
  title,
  subtitle,
  statusLabel,
  statusTone,
  checking = false,
  entry,
  onOpen,
}: {
  icon: ComponentProps<typeof Icon>['icon'];
  title: string;
  subtitle: string;
  statusLabel: string;
  statusTone: StatusBadgeTone;
  checking?: boolean;
  /** The page this card opens: the focus comes back here when that page is left. */
  entry: NonNullable<CapabilityDetailView>;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onClick={onOpen}
      data-capability-entry={entry}
      // The status is the whole reason this row exists, so it belongs in the
      // accessible name — a screen reader hearing only "My Chrome" learns
      // nothing the page did not already imply.
      aria-label={`${title} · ${statusLabel}`}
      className="flex w-full items-center gap-3 rounded-panel border border-separator p-4 text-left hover:bg-fill-hover"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-fill text-label-secondary">
        <Icon icon={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ui font-medium text-label">{title}</span>
          {/* Three cards can be checking at once, so a card never spins. */}
          <StatusBadge label={statusLabel} tone={statusTone} checking={checking} />
        </span>
        <span className="mt-1 block text-ui-sm text-label-secondary">
          {subtitle}
        </span>
      </span>
      <Icon icon={AppIcons.disclose} className="text-label-tertiary" />
    </Pressable>
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
  const chromeBridgeEnabled = chromeBridge?.config.enabled ?? true;
  const chromeBridgeStatus = chromeBridge?.status;
  const chromeRuntimeChecking = (
    chromeBridgeStatus === 'connecting' || chromeBridgeStatus === 'reconnecting'
  );

  const [permissions, setPermissions] = useState<ComputerUsePermissions>();
  const [browserChecking, setBrowserChecking] = useState(false);
  const [chromeChecking, setChromeChecking] = useState(false);
  const [chromeExtensionConnected, setChromeExtensionConnected] = useState<boolean>();
  /*
    Has the extension ever answered the handshake. It separates "never set up"
    from "was working and broke", and because it only ever latches ON, two
    probes racing cannot make the card describe the same machine two different
    ways depending on which lands last.

    The truth lives in a module (see chromeHandshakeLatch), not here: this
    component unmounts every time the settings dialog closes, and a genuinely
    lost connection must not read as "never connected" again just because
    someone closed and reopened settings. The local state exists only to
    re-render on change.
  */
  const [chromeExtensionEverConnected, setChromeExtensionEverConnectedState] =
    useState(hasChromeExtensionHandshaked);
  const setChromeExtensionEverConnected = useCallback((value: boolean) => {
    setChromeExtensionHandshaked(value);
    setChromeExtensionEverConnectedState(value);
  }, []);
  /*
    Probe ordering. Several paths probe the extension (the bridge-status
    effect, the Check button, the setup flow, the setup-page poll) and they
    can overlap; without a sequence the SLOWEST reply won rather than the
    NEWEST, so a stale answer could overwrite a fresh one.
  */
  const chromeProbeSeqRef = useRef(0);
  const [computerChecking, setComputerChecking] = useState(false);
  const [setupView, setSetupView] = useState<CapabilityDetailView>(
    setupTarget ?? null,
  );
  // Which channel's detail page the site list was opened from, so "back" lands
  // where the user actually was rather than always on the built-in browser.
  const [sitesOrigin, setSitesOrigin] = useState<BrowserBackend>('builtin');
  // The pages of this section replace each other under the keyboard. When the control that had
  // the focus went away with its page, the focus goes to the entry of the page just left (on the
  // way back), or to the new page's way back (on the way in). Focus that sits elsewhere stays.
  const viewRoot = useRef<HTMLDivElement>(null);
  const viewShown = useRef(setupView);
  useLayoutEffect(() => {
    const left = viewShown.current;
    viewShown.current = setupView;
    const root = viewRoot.current;
    if (left === setupView || !root) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const entries = [left, left === 'sites' ? sitesOrigin : left === 'downloads' ? 'builtin' : null];
    const target = entries
      .map((entry) => (entry ? root.querySelector<HTMLElement>(`[data-capability-entry="${entry}"]`) : null))
      .find((entry) => entry !== null)
      ?? root.querySelector<HTMLElement>('[data-capability-back]');
    target?.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
  }, [setupView, sitesOrigin]);
  const inViewRoot = (view: ReactNode) => <div ref={viewRoot} className="contents">{view}</div>;
  const [setupRequestedByTask, setSetupRequestedByTask] =
    useState(requestedByTask);
  const [chromeSetupWorking, setChromeSetupWorking] = useState(false);
  const [chromeInstallerOpening, setChromeInstallerOpening] = useState(false);
  const [chromeExtensionPath, setChromeExtensionPath] = useState<string | null>();
  const [chromeSetupError, setChromeSetupError] = useState<string>();
  const [chromeInstallation, setChromeInstallation] = useState<ChromeExtensionInstallation>();
  const [requestingComputerPermission, setRequestingComputerPermission] =
    useState<ComputerUsePermission>();
  const [revealingComputerUseApp, setRevealingComputerUseApp] = useState(false);
  const computerPermissionCheckRef =
    useRef<Promise<ComputerUsePermissions | undefined> | null>(null);
  const [, setRuntimeRevision] = useState(0);
  const activeProvider = providers.find((provider) => provider.id === activeModel.providerId);
  const computerModelCapabilities = useMemo(() => resolveAgentModelCapabilities({
    modelId: activeModel.modelId,
    providerSource: activeProvider?.source,
    declared: resolveModelDeclared(activeProvider, activeModel.modelId),
  }), [activeModel.modelId, activeProvider]);

  useEffect(() => mcpManager.subscribe(() => {
    setRuntimeRevision((revision) => revision + 1);
  }), []);

  /** The one way this component learns whether the extension is attached. */
  const probeChromeExtension = useCallback(async (
    { keepLastWhenUnknown = false }: { keepLastWhenUnknown?: boolean } = {},
  ) => {
    const seq = ++chromeProbeSeqRef.current;
    const connected = await probeChromeBridgeConnection();
    // A newer probe (or a disconnect) already spoke: this answer is history.
    if (seq !== chromeProbeSeqRef.current) return connected;
    if (connected === undefined && keepLastWhenUnknown) return connected;
    setChromeExtensionConnected(connected);
    if (connected === true) setChromeExtensionEverConnected(true);
    return connected;
  }, [setChromeExtensionEverConnected]);

  useEffect(() => {
    if (!chromeBridge || !chromeBridgeEnabled || chromeBridgeStatus !== 'connected') {
      /*
        Invalidate in-flight probes BEFORE clearing, exactly as an explicit
        disconnect does. A probe started while the bridge was up can otherwise
        land after the bridge has died and report `true` — its sequence is
        still current, so the guard waves it through, and the derivation
        (which tests `extensionConnected === true` first) then renders a dead
        bridge as ready AND latches the handshake. The bridge's own status
        used to backstop that; once "has it ever handshaked" was allowed to
        outrank runtime status, this bump became the backstop.
      */
      chromeProbeSeqRef.current += 1;
      setChromeExtensionConnected(undefined);
      setChromeChecking(false);
      return;
    }

    let active = true;
    setChromeChecking(true);
    void probeChromeExtension().then(() => {
      if (active) setChromeChecking(false);
    });
    return () => {
      active = false;
    };
  }, [chromeBridge, chromeBridgeEnabled, chromeBridgeStatus, probeChromeExtension]);

  const statuses = deriveCapabilityStatuses(
    readCapabilityRuntimeSnapshot({
      chromeBridge: chromeBridge
        ? {
            enabled: chromeBridge.config.enabled ?? true,
            status: chromeBridge.status,
            extensionConnected: chromeExtensionConnected,
            extensionEverConnected: chromeExtensionEverConnected,
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
    await probeChromeExtension();
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
      await probeChromeExtension();
    } catch (error) {
      setChromeSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setChromeSetupWorking(false);
    }
  }, [chromeBridge, chromeBridgeEnabled, probeChromeExtension, updateMCPServer]);

  const openChromeSetup = () => {
    setSetupRequestedByTask(false);
    setSetupView('chrome');
    setChromeSetupError(undefined);
    void resolveMCPCompanionResource(CAPABILITY_IDS.chromeBridge)
      .then(setChromeExtensionPath)
      .catch(() => setChromeExtensionPath(null));
  };

  const openChromeInstaller = async (target: 'page' | 'folder' = 'page') => {
    if (target === 'folder' && !chromeExtensionPath) return;
    setChromeInstallerOpening(true);
    setChromeSetupError(undefined);
    const result = await openBundledChromeExtensionSetup(chromeExtensionPath ?? '', target);
    setChromeInstallerOpening(false);
    if (target === 'folder' ? !result.extensionFolderOpened : !result.extensionsPageOpened) {
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
      await requestComputerUsePermission(permission);
      await syncComputerPermissions(false);
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.capabilityStatusUnavailable,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
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
      void probeChromeExtension({ keepLastWhenUnknown: true });
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [
    chromeBridgeEnabled,
    chromeBridgeStatus,
    chromeExtensionConnected,
    probeChromeExtension,
    setupView,
  ]);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const installation = await getChromeExtensionInstallation();
        if (active) setChromeInstallation(installation);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const poll = window.setInterval(() => { void refresh(); }, 5_000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.removeEventListener('focus', refresh);
    };
  }, [setupView]);

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

  const browserStatus = statuses[CAPABILITY_IDS.builtinBrowser];
  const computerStatus = statuses[CAPABILITY_IDS.computerUse];
  const computerModelTier = computerModelCapabilities.computerUseTier;
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

  // Off is a state the user chose, not a fault, so it gets the standing
  // one-liner like any other nominal state — the badge already says "off",
  // and a line repeating the badge spends the card's only line on nothing.
  const computerFaultNote = computerModelCapabilities.computerUseTier === 'unsupported'
    || computerModelCapabilities.computerUseTier === 'unknown'
    ? computerModelTierNotes[computerModelCapabilities.computerUseTier]
    : screenPermission && !controlPermission
      ? t.settings.capabilityComputerPartial
      : computerStatus.code === 'permission-required'
        ? t.settings.capabilityComputerPermissionMissing
        : t.settings.capabilityComputerSubtitle;

  // Only ever read when the capability is NOT ready, so it says what is
  // wrong and nothing else; the working case has its own one-liner.
  const browserFaultNote = browserStatus.code === 'unavailable'
    ? t.settings.capabilityBuiltinBrowserUnavailable
    : t.settings.capabilityBuiltinBrowserDisconnected;

  // Installation survives Chrome closing; transport health belongs to task execution.
  const chromeStatusLabel = chromeInstallation === 'installed'
    ? t.settings.capabilityChromeInstalled
    : chromeInstallation === 'not-installed'
      ? t.settings.capabilityChromeNotInstalled
      : chromeInstallation === 'unknown'
        ? t.settings.capabilityChromeInstallationUnknown
        : t.settings.capabilityStatusChecking;
  const chromeStatusTone: StatusBadgeTone = chromeInstallation === 'installed'
    ? 'ready'
    : 'neutral';

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

  const [browserDownloadsQuery, setBrowserDownloadsQuery] = useState('');
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
    return inViewRoot(
      <BrowserSitePermissionsPage
        trail={sitesTrail}
        onNavigate={navigateTrail(sitesOrigin)}
      />
    );
  }

  if (setupView === 'downloads') return inViewRoot(<BrowserDownloadHistoryPage
    trail={[...builtinTrail, t.settings.browserDownloadsTitle]}
    onNavigate={(index) => { if (index === 0) cancelSetup(); else setSetupView('builtin'); }}
    query={browserDownloadsQuery} onQueryChange={setBrowserDownloadsQuery} />);

  if (setupView === 'builtin') {
    return inViewRoot(
      <div className="space-y-6">
        <SetupHeader
          icon={AppIcons.webPage}
          title={t.settings.capabilityBuiltinBrowser}
          description={t.settings.capabilityBuiltinBrowserSubtitle}
          onBack={cancelSetup}
          breadcrumb={builtinTrail}
        />

        {/*
          No status row while the browser is working. Unlike the other two
          channels there is nothing to connect and nothing to switch on, so a
          working built-in browser has no state worth reporting and no action
          to offer: the badge on the card the user just came through already
          said "ready", and the line under the title already says what "its
          own session" means. The row would have restated both.

          A broken one is the opposite case — that is the only place the fault
          and the retry can live, so the row comes back for it.
        */}
        {browserStatus.code !== 'ready' && (
          <CapabilityStatusRow
            label={browserChecking
              ? t.settings.capabilityStatusChecking
              : statusLabels[browserStatus.code]}
            tone={badgeToneFor(browserStatus.code)}
            checking={browserChecking}
            note={browserFaultNote}
            action={(
              // The row's badge is the one spinner while this runs; the icon here stays still.
              <Button
                variant="secondary"
                size="sm"
                icon={AppIcons.retry}
                onClick={handleBrowserRetry}
                disabled={browserChecking || browserStatus.reason === 'unsupported-shell'}
              >
                {browserStatus.code === 'connection-lost'
                  ? t.settings.capabilityRetry
                  : t.settings.capabilityCheckStatus}
              </Button>
            )}
          />
        )}

        <BrowserPermissionCards
          backend="builtin"
          onManageSites={() => openSitePermissions('builtin')}
        />
        <BrowserDownloadHistoryEntry onOpen={() => setSetupView('downloads')} />
      </div>
    );
  }

  if (setupView === 'chrome') {
    return inViewRoot(
      <ChromeSetupView
        capabilityEnabled={Boolean(chromeBridge && chromeBridgeEnabled)}
        requestedByTask={setupRequestedByTask}
        runtimeReady={chromeBridgeEnabled && chromeBridgeStatus === 'connected'}
        extensionConnected={chromeExtensionConnected === true}
        installation={chromeInstallation}
        extensionPath={chromeExtensionPath}
        connecting={chromeSetupWorking || chromeChecking || chromeRuntimeChecking}
        openingInstaller={chromeInstallerOpening}
        error={chromeSetupError}
        breadcrumb={chromeTrail}
        onBack={cancelSetup}
        onPrepare={prepareChromeBridge}
        onOpenInstaller={openChromeInstaller}
        onDone={completeSetup}
      />
    );
  }

  if (setupView === 'computer') {
    return inViewRoot(
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
          if (setupRequestedByTask) cancelSetup();
        }}
        onDone={completeSetup}
        modelIssue={computerModelCapabilities.computerUseTier === 'unsupported' || computerModelCapabilities.computerUseTier === 'unknown'
          ? computerModelTierNotes[computerModelCapabilities.computerUseTier] : undefined}
        onRelaunch={setupRequestedByTask ? onSetupRelaunch : async () => {
          try {
            await restartApp();
          } catch (error) {
            useToastStore.getState().addToast({
              type: 'error', title: t.settings.capabilityStatusUnavailable,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }}
      >
        {/*
          The active model decides whether Computer Use can see the screen at
          all, so it belongs beside the permissions it gates rather than on the
          overview, where it was a second status the card had to explain.
        */}
        {/* Keyed by tier: a model that cannot be used opens the section when it is picked. */}
        <Disclosure
          key={computerModelTier}
          title={t.settings.capabilityComputerModel}
          defaultOpen={computerModelTier === 'unsupported' || computerModelTier === 'unknown'}
        >
          <p className="min-w-0 break-all text-ui-sm text-label-secondary">
            {activeModel.modelId || t.settings.capabilityComputerModelUnknown}
            {' · '}{computerModelTierLabels[computerModelTier]}
          </p>
          <p className={cn('mt-1 flex items-start gap-1 text-caption',
            computerModelTier === 'unsupported' ? 'text-danger'
              : computerModelTier === 'unknown' ? 'text-warning'
                : 'text-label-tertiary')}>
            {computerModelTier === 'unsupported' && <StatusIcon tone="danger" size="sm" />}
            {computerModelTier === 'unknown' && <StatusIcon tone="warning" size="sm" />}
            <span className="min-w-0">{computerModelTierNotes[computerModelTier]}</span>
          </p>
        </Disclosure>
      </ComputerUseSetupView>
    );
  }

  return inViewRoot(
    <div className="space-y-6">
      <SettingsSectionHeader
        title={t.settings.capabilityOverview}
        description={t.settings.capabilitiesDescription}
      />

      <section className="space-y-3">
        <h4 className="text-ui-sm font-medium text-label-tertiary">
          {t.settings.capabilityWebTitle}
        </h4>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {/*
            A card shows its standing description while everything is fine, and
            switches to the live note the moment it is not — one line either
            way, and a problem is never hidden behind a marketing sentence.
          */}
          <ChannelCard
            icon={AppIcons.webPage}
            title={t.settings.capabilityBuiltinBrowser}
            subtitle={browserStatus.code === 'ready'
              ? t.settings.capabilityBuiltinBrowserSubtitle
              : browserFaultNote}
            statusLabel={browserChecking
              ? t.settings.capabilityStatusChecking
              : statusLabels[browserStatus.code]}
            statusTone={badgeToneFor(browserStatus.code)}
            checking={browserChecking}
            entry="builtin"
            onOpen={openBuiltinBrowser}
          />

          <ChannelCard
            icon={AppIcons.chrome}
            title={t.settings.capabilityMyChrome}
            subtitle={t.settings.capabilityMyChromeSubtitle}
            statusLabel={chromeStatusLabel}
            statusTone={chromeStatusTone}
            checking={chromeInstallation === undefined}
            entry="chrome"
            onOpen={openChromeSetup}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-ui-sm font-medium text-label-tertiary">
          {t.settings.capabilityComputerTitle}
        </h4>
        <ChannelCard
          icon={AppIcons.computerUse}
          title={t.settings.computerUse}
          subtitle={!computerUseEnabled || computerDisplayStatus.code === 'ready'
            ? t.settings.capabilityComputerSubtitle
            : computerFaultNote}
          statusLabel={computerStatusLabel}
          statusTone={computerStatusTone}
          checking={computerChecking}
          entry="computer"
          onOpen={openComputerSetup}
        />
      </section>

    </div>
  );
}
