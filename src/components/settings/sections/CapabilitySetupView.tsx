import {
  ArrowLeft,
  ChevronRight,
  CheckCircle2,
  Chrome,
  CircleAlert,
  Eye,
  FolderOpen,
  LoaderCircle,
  MonitorCog,
  MousePointer2,
  RefreshCw,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type {
  ComputerUsePermission,
  ComputerUsePermissionRequirements,
  ComputerUsePermissions,
} from '@/core/agent/computerUsePermission';

type SetupState = 'complete' | 'pending' | 'upcoming' | 'working';

function SetupStateLabel({ state }: { state: SetupState }) {
  const { t } = useI18n();
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-caption font-medium',
      state === 'complete' && 'bg-[var(--abu-success-bg)] text-[var(--abu-success)]',
      state === 'pending' && 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]',
      state === 'upcoming' && 'bg-[var(--abu-bg-active)] text-[var(--abu-text-muted)]',
      state === 'working' && 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]',
    )}>
      {state === 'complete' && <CheckCircle2 className="h-3 w-3" />}
      {state === 'pending' && <CircleAlert className="h-3 w-3" />}
      {state === 'working' && <LoaderCircle className="h-3 w-3 animate-spin" />}
      {state === 'complete'
        ? t.settings.capabilityStatusReady
        : state === 'working'
          ? t.settings.capabilityStatusChecking
          : state === 'upcoming'
            ? t.settings.capabilityStatusNextStep
          : t.settings.capabilityStatusSetupRequired}
    </span>
  );
}

/**
 * The only three outcomes a capability reports. The five runtime status codes
 * collapse onto them because a badge answers "can I use this right now", not
 * "which subsystem failed" — the one line beside it carries the specific
 * reason, so nothing is lost by not spelling it out twice.
 *
 * `checking` is not a fourth outcome: it is the transient look of a probe in
 * flight, and the badge returns to one of the three as soon as it lands.
 */
export type StatusBadgeTone = 'ready' | 'neutral' | 'attention';

export function StatusBadge({
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
 * The one row every capability detail page carries under its title: what state
 * the capability is in, one line saying what that state means, and the single
 * action that changes it.
 *
 * One row and one action is the whole rule. A page that also restated the
 * state in a callout, a second badge, and a closing paragraph made the reader
 * cross-check four descriptions of one fact to find out whether the thing was
 * on — so the row is the ONLY place any of them appears, and a page with
 * nothing to say and nothing to do simply does not render it.
 */
export function CapabilityStatusRow({
  label,
  tone,
  checking = false,
  note,
  action,
}: {
  label: string;
  tone: StatusBadgeTone;
  checking?: boolean;
  /** One line. If it only restates the badge, there is no row to build. */
  note: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-[var(--abu-border)] py-4">
      <StatusBadge label={label} tone={tone} checking={checking} />
      <span className="min-w-0 flex-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {note}
      </span>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Trail back to the capability overview. Replaces the plain back arrow on any
 * detail page reached by the user's own drill-in, so the page says WHERE it
 * sits, not just that there is a way out. A detail page opened BY A TASK keeps
 * the arrow instead — that exit means "cancel and return to the task", which a
 * location trail cannot express.
 *
 * The root segment keeps the old back button's accessible name so anything
 * that targeted "back to capabilities" still finds it.
 */
export function CapabilityBreadcrumb({
  trail,
  onNavigate,
}: {
  /** Leaf-last. Every segment but the last is a link back up the trail. */
  trail: string[];
  onNavigate: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <nav className="mb-5 flex flex-wrap items-center gap-1 text-minor font-medium text-[var(--abu-text-muted)]">
      {trail.map((segment, index) => {
        const isLeaf = index === trail.length - 1;
        return (
          <span key={`${segment}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
            {isLeaf ? (
              <span className="text-[var(--abu-text-secondary)]">{segment}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(index)}
                aria-label={index === 0 ? t.settings.capabilityBackToOverview : segment}
                className="transition-colors hover:text-[var(--abu-text-primary)]"
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function SetupHeader({
  icon: Icon,
  title,
  description,
  onBack,
  backLabel,
  breadcrumb,
  action,
}: {
  icon: typeof Chrome;
  title: string;
  description: string;
  onBack: () => void;
  backLabel?: string;
  /** Leaf-last location trail. When given, it replaces the back arrow. */
  breadcrumb?: string[];
  action?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div>
      {breadcrumb ? (
        <CapabilityBreadcrumb trail={breadcrumb} onNavigate={onBack} />
      ) : (
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex items-center gap-1.5 text-minor font-medium text-[var(--abu-text-muted)] transition-colors hover:text-[var(--abu-text-primary)]"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel ?? t.settings.capabilityBackToOverview}
        </button>
      )}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--abu-clay-bg)] text-[var(--abu-clay)]">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">{title}</h3>
          <p className="mt-1 max-w-2xl text-minor leading-relaxed text-[var(--abu-text-muted)]">
            {description}
          </p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

function SetupRow({
  icon: Icon,
  title,
  description,
  state,
  action,
}: {
  icon: typeof Chrome;
  title: string;
  description: string;
  state: SetupState;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--abu-border)] py-4 last:border-b-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-body font-medium text-[var(--abu-text-primary)]">{title}</h4>
          <SetupStateLabel state={state} />
        </div>
        <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The neutral settings card every capability detail page is built out of. */
export const settingsCardClass =
  'rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4';

const secondaryButtonClass =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-3 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';

/** The status row's action. Same height as the secondary button beside it, so
 *  the row reads as one control strip whichever state the page is in. */
const rowActionButtonClass =
  'inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--abu-clay)] px-3 text-minor font-medium text-white transition-colors hover:bg-[var(--abu-clay-hover)] disabled:cursor-not-allowed disabled:opacity-50';

export function ChromeSetupView({
  capabilityEnabled,
  requestedByTask,
  runtimeReady,
  extensionConnected,
  extensionPath,
  working,
  openingInstaller,
  error,
  onBack,
  onPrepare,
  onOpenInstaller,
  onCheck,
  onDone,
  onDisconnect,
  breadcrumb,
  children,
}: {
  capabilityEnabled: boolean;
  requestedByTask: boolean;
  runtimeReady: boolean;
  extensionConnected: boolean;
  extensionPath: string | null | undefined;
  working: boolean;
  openingInstaller: boolean;
  error?: string;
  onBack: () => void;
  onPrepare: () => void;
  onOpenInstaller: () => void;
  onCheck: () => void;
  onDone: () => void;
  onDisconnect: () => void;
  breadcrumb?: string[];
  /** The shared browser permission cards, mounted for this channel. */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();

  /*
    One row, one action, and the action is decided by what is actually
    missing:
      - the bridge was never enabled (or was disconnected) → the explicit
        opt-in, which is still the ONLY thing that starts the local runtime;
      - enabled but the local runtime is down → retry it;
      - running but no extension answering → open the install windows;
      - connected → disconnect.
    Disconnect appears in exactly one of those, because offering to disconnect
    something that is not connected is the page telling the user it is
    connected.
  */
  const needsRuntime = capabilityEnabled && !runtimeReady;
  const statusLabel = extensionConnected
    ? t.settings.capabilityStatusConnected
    : needsRuntime
      ? t.settings.capabilityStatusSetupRequired
      : t.settings.capabilityStatusNotConnected;
  const statusTone: StatusBadgeTone = extensionConnected
    ? 'ready'
    : needsRuntime
      ? 'attention'
      : 'neutral';
  const statusNote = extensionConnected
    // The one consent sentence this page keeps, in place of the footer
    // paragraph that said it at four times the length.
    ? t.settings.capabilityMyChromeScope
    : requestedByTask && !capabilityEnabled
      ? t.settings.capabilityChromeTaskNeedsSetup
      : needsRuntime
        ? t.settings.capabilityChromeServiceUnavailable
        : t.settings.capabilityChromeExtensionDesc;

  const statusAction = extensionConnected ? (
    <button
      type="button"
      onClick={onDisconnect}
      disabled={working}
      // Shown short because the page is already titled "My Chrome"; the
      // accessible name keeps the full phrase, and contains the visible text.
      aria-label={t.settings.capabilityChromeDisconnect}
      className={secondaryButtonClass}
    >
      {t.settings.capabilityChromeDisconnectShort}
    </button>
  ) : !capabilityEnabled ? (
    <button
      type="button"
      onClick={onPrepare}
      disabled={working}
      className={rowActionButtonClass}
    >
      {working && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
      {t.settings.capabilityChromeConnect}
    </button>
  ) : needsRuntime ? (
    <button
      type="button"
      onClick={onPrepare}
      disabled={working}
      className={rowActionButtonClass}
    >
      <RefreshCw className={cn('h-3.5 w-3.5', working && 'animate-spin')} />
      {t.settings.capabilityRetry}
    </button>
  ) : (
    <button
      type="button"
      onClick={onOpenInstaller}
      disabled={working || !extensionPath || openingInstaller}
      className={rowActionButtonClass}
    >
      {openingInstaller || working
        ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        : <FolderOpen className="h-3.5 w-3.5" />}
      {t.settings.capabilityChromeOpenInstaller}
    </button>
  );

  return (
    <div className="space-y-7">
      <SetupHeader
        icon={Chrome}
        title={t.settings.capabilityMyChrome}
        description={t.settings.capabilityMyChromeSubtitle}
        onBack={onBack}
        backLabel={requestedByTask ? t.common.cancel : undefined}
        breadcrumb={requestedByTask ? undefined : breadcrumb}
      />

      <CapabilityStatusRow
        label={working ? t.settings.capabilityStatusChecking : statusLabel}
        tone={statusTone}
        checking={working}
        note={statusNote}
        action={statusAction}
      />

      {/*
        Installation guidance, and nothing but: it is addressed to someone who
        has no extension attached, so a user who already connected one never
        sees it. The developer-mode warning lives INSIDE it rather than as a
        standalone callout, because it is a fact about step 2.
      */}
      {!extensionConnected && (
        <div className="space-y-3">
          <h4 className="text-body font-medium text-[var(--abu-text-primary)]">
            {t.settings.capabilityChromeManualTitle}
          </h4>
          <ol className="space-y-2 text-minor leading-relaxed text-[var(--abu-text-secondary)]">
            {[
              t.settings.capabilityChromeManualStep1,
              t.settings.capabilityChromeManualStep2,
              t.settings.capabilityChromeManualStep3,
            ].map((step, index) => (
              <li key={step} className="flex items-start gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--abu-bg-active)] text-caption font-medium text-[var(--abu-text-secondary)]">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="flex items-start gap-2 text-minor leading-relaxed text-[var(--abu-text-secondary)]">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-warning)]" />
            {t.settings.capabilityChromeExperimental}
          </p>
          <p className="flex items-start gap-2 text-minor leading-relaxed text-[var(--abu-text-muted)]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-warning)]" />
            {t.settings.capabilityChromePermissionScope}
          </p>
          {extensionPath === null && (
            <p className="flex items-start gap-2 text-minor text-[var(--abu-warning)]">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t.settings.capabilityChromeResourceMissing}
            </p>
          )}
          {/*
            Abu detects the connection on its own; this is the manual nudge for
            someone who does not want to wait. Conditionally rendered, NOT
            `hidden={!capabilityEnabled}`: Tailwind v4 puts utilities in a later
            cascade layer than preflight, so `.inline-flex` outranks preflight's
            `[hidden] { display: none }` and the attribute does nothing — the
            button went on offering to check a connection for a bridge that is
            not even enabled.
          */}
          {capabilityEnabled && (
            <button
              type="button"
              onClick={onCheck}
              disabled={working}
              className={secondaryButtonClass}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', working && 'animate-spin')} />
              {t.settings.capabilityCheckConnection}
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-start gap-2 text-minor text-[var(--abu-danger)]">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {children}

      {/* Only a task has somewhere to go back TO; everyone else has the
          breadcrumb, and a second way out is not a feature. */}
      {extensionConnected && requestedByTask && (
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--abu-border)] pt-4">
          <button
            type="button"
            onClick={onDone}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--abu-clay)] px-4 text-body font-medium text-white transition-colors hover:bg-[var(--abu-clay-hover)]"
          >
            <CheckCircle2 className="h-4 w-4" />
            {t.settings.capabilityReturnToTask}
          </button>
        </div>
      )}
    </div>
  );
}

export function ComputerUseSetupView({
  enabled,
  requestedByTask,
  requirements,
  permissions,
  checking,
  requesting,
  revealingApp,
  canOpenSystemSettings,
  onBack,
  onEnable,
  onRequestPermission,
  onRevealApp,
  onRefresh,
  onDisable,
  onDone,
  onRelaunch,
  breadcrumb,
  children,
}: {
  enabled: boolean;
  requestedByTask: boolean;
  requirements?: ComputerUsePermissionRequirements;
  permissions?: ComputerUsePermissions;
  checking: boolean;
  requesting?: ComputerUsePermission;
  revealingApp: boolean;
  canOpenSystemSettings: boolean;
  onBack: () => void;
  onEnable: () => void;
  onRequestPermission: (permission: ComputerUsePermission) => void;
  onRevealApp: () => void;
  onRefresh: () => void;
  onDisable: () => void;
  onDone: () => void;
  onRelaunch?: () => void;
  breadcrumb?: string[];
  /** The active-model capability summary, which belongs with the permissions
   *  it gates rather than on the overview. */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const required = requirements ?? { screenRead: true, uiControl: true };
  const screenReady = permissions?.screenRead === true;
  const controlReady = permissions?.uiControl === true;
  const fullyReady = enabled
    && (!required.screenRead || screenReady)
    && (!required.uiControl || controlReady);
  const restartRequired = permissions?.restartRequired === true;
  const currentPermission: ComputerUsePermission | undefined = required.screenRead && !screenReady
    ? 'screenRead'
    : required.uiControl && !controlReady
      ? 'uiControl'
      : undefined;
  const oneRequiredPermission = Number(required.screenRead) + Number(required.uiControl) === 1;
  const currentStepLabel = oneRequiredPermission
    ? t.settings.capabilityComputerStepOnly
    : currentPermission === 'screenRead'
      ? t.settings.capabilityComputerStepScreen
      : t.settings.capabilityComputerStepControl;
  const currentTitle = currentPermission === 'screenRead'
    ? t.settings.capabilityScreenRead
    : t.settings.capabilityUIControl;
  const currentInstruction = currentPermission === 'screenRead'
    ? t.settings.capabilityScreenReadInstruction
    : t.settings.capabilityUIControlInstruction;
  const currentRequesting = requesting === currentPermission;

  // Off is a state the user chose, so it is reported like any other state —
  // one badge, one line, one button — instead of as a callout arguing for
  // itself. Turning it on does exactly what it did before.
  const statusLabel = !enabled
    ? t.settings.capabilityStatusOff
    : fullyReady && !restartRequired
      ? t.settings.capabilityStatusReady
      : t.settings.capabilityStatusSetupRequired;
  const statusTone: StatusBadgeTone = !enabled
    ? 'neutral'
    : fullyReady && !restartRequired
      ? 'ready'
      : 'attention';
  const statusNote = !enabled
    ? (requestedByTask
      ? t.settings.capabilityComputerTaskNeedsSetup
      : t.settings.capabilityComputerConfirmEnable)
    : fullyReady && !restartRequired
      // The one clause worth keeping from the closing paragraph: WHEN Abu
      // looks at the screen. The rest of it repeated the badge and the button.
      ? t.settings.capabilityComputerReadyNote
      : t.settings.capabilityComputerPermissionMissing;

  return (
    <div className="space-y-7">
      <SetupHeader
        icon={MonitorCog}
        title={t.settings.capabilityComputerSetupTitle}
        description={t.settings.capabilityComputerSubtitle}
        onBack={onBack}
        backLabel={requestedByTask ? t.common.cancel : undefined}
        breadcrumb={requestedByTask ? undefined : breadcrumb}
      />

      <CapabilityStatusRow
        label={checking ? t.settings.capabilityStatusChecking : statusLabel}
        tone={statusTone}
        checking={checking}
        note={statusNote}
        action={enabled ? (
          <button
            type="button"
            onClick={onDisable}
            // Short on screen, full phrase as the accessible name — see
            // `capabilityChromeDisconnect` for the same pairing.
            aria-label={t.settings.capabilityComputerDisable}
            className={secondaryButtonClass}
          >
            {t.settings.capabilityComputerDisableShort}
          </button>
        ) : (
          <button
            type="button"
            onClick={onEnable}
            className={rowActionButtonClass}
          >
            {t.settings.capabilityComputerEnable}
          </button>
        )}
      />

      {children}

      {enabled && (
        <>
          <div className="border-y border-[var(--abu-border)]">
            {required.screenRead && (
              <SetupRow
                icon={Eye}
                title={t.settings.capabilityScreenRead}
                description={t.settings.capabilityScreenReadDesc}
                state={screenReady
                  ? 'complete'
                  : requesting === 'screenRead'
                    ? 'working'
                    : 'pending'}
              />
            )}
            {required.uiControl && (
              <SetupRow
                icon={MousePointer2}
                title={t.settings.capabilityUIControl}
                description={t.settings.capabilityUIControlDesc}
                state={controlReady
                  ? 'complete'
                  : requesting === 'uiControl'
                    ? 'working'
                    : required.screenRead && !screenReady
                      ? 'upcoming'
                      : 'pending'}
              />
            )}
          </div>

          {currentPermission && !restartRequired && canOpenSystemSettings && (
            <div
              className="space-y-4 border-l-2 border-[var(--abu-clay)] pl-4"
              aria-live="polite"
            >
              <div>
                <p className="text-caption font-medium text-[var(--abu-clay)]">
                  {currentStepLabel}
                </p>
                <h4 className="mt-1 text-body font-semibold text-[var(--abu-text-primary)]">
                  {currentTitle}
                </h4>
                <p className="mt-1 max-w-2xl text-minor leading-relaxed text-[var(--abu-text-secondary)]">
                  {currentInstruction}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onRequestPermission(currentPermission)}
                  disabled={checking || requesting !== undefined}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--abu-clay)] px-4 text-body font-medium text-white transition-colors hover:bg-[var(--abu-clay-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {currentRequesting
                    ? <LoaderCircle className="h-4 w-4 animate-spin" />
                    : <Settings className="h-4 w-4" />}
                  {t.settings.capabilityOpenSystemSettings}
                </button>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={checking || requesting !== undefined}
                  className={secondaryButtonClass}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
                  {t.settings.capabilityCheckAgain}
                </button>
              </div>

              <p className="text-minor leading-relaxed text-[var(--abu-text-muted)]">
                {t.settings.capabilityComputerAutomaticCheck}
              </p>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--abu-border)] pt-3">
                <p className="max-w-xl text-minor leading-relaxed text-[var(--abu-text-muted)]">
                  {t.settings.capabilityComputerMissingApp}
                </p>
                <button
                  type="button"
                  onClick={onRevealApp}
                  disabled={revealingApp}
                  className={secondaryButtonClass}
                >
                  {revealingApp
                    ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    : <FolderOpen className="h-3.5 w-3.5" />}
                  {t.settings.capabilityShowAppInFinder}
                </button>
              </div>
            </div>
          )}

          {currentPermission && !restartRequired && !canOpenSystemSettings && (
            <div className="space-y-3 border-l-2 border-[var(--abu-warning)] pl-4">
              <p className="flex items-start gap-2 text-minor leading-relaxed text-[var(--abu-warning)]">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t.settings.capabilityComputerPlatformHint}
              </p>
              <button
                type="button"
                onClick={onRefresh}
                disabled={checking || requesting !== undefined}
                className={secondaryButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
                {t.settings.capabilityCheckAgain}
              </button>
            </div>
          )}

          {restartRequired && requestedByTask && onRelaunch && (
            <div className="space-y-3 border-l-2 border-[var(--abu-warning)] pl-4">
              <p className="text-body font-semibold text-[var(--abu-text-primary)]">
                {t.settings.capabilityPermissionGuideRestartTitle}
              </p>
              <p className="text-minor leading-relaxed text-[var(--abu-text-muted)]">
                {t.settings.capabilityPermissionGuideRestartDesc}
              </p>
              <button
                type="button"
                onClick={onRelaunch}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--abu-clay)] px-4 text-body font-medium text-white transition-colors hover:bg-[var(--abu-clay-hover)]"
              >
                <RefreshCw className="h-4 w-4" />
                {t.settings.capabilityPermissionGuideRestart}
              </button>
            </div>
          )}

          {/* The status row already says it is ready, in the same words it
              uses for every other state. What is left is the one thing the
              row cannot do: hand a waiting task back its turn. Nobody else
              needs a second exit — the breadcrumb is the first. */}
          {fullyReady && !restartRequired && requestedByTask && (
            <div className="border-t border-[var(--abu-border)] pt-4">
              <button
                type="button"
                onClick={onDone}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--abu-clay)] px-4 text-body font-medium text-white transition-colors hover:bg-[var(--abu-clay-hover)]"
              >
                <CheckCircle2 className="h-4 w-4" />
                {t.settings.capabilityReturnToTask}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
