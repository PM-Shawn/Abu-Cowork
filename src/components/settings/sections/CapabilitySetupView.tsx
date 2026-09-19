import { useId, useState } from 'react';
import type { ChromeExtensionInstallation } from '@/core/capabilityPlugins/chromeSetup';
import {
  ArrowLeft,
  ChevronRight,
  Chrome,
  Eye,
  MousePointer2,
  FolderOpen,
  LoaderCircle,
  MonitorCog,
  RefreshCw,
} from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import type {
  ComputerUsePermission,
  ComputerUsePermissionRequirements,
  ComputerUsePermissions,
} from '@/core/agent/computerUsePermission';

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

/** The neutral settings card every capability detail page is built out of. */
export const settingsCardClass =
  'rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4';

function ChromeInstallationHelp({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div>
    <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id}
      className="h-auto gap-1.5 p-0 text-minor text-[var(--abu-text-muted)] hover:bg-transparent hover:text-[var(--abu-text-primary)]"
      onClick={() => setOpen(!open)}>
      <ChevronRight aria-hidden="true" className={cn('size-4 transition-transform', open && 'rotate-90')} />
      {t.settings.capabilityChromeSetupHelp}
    </Button>
    {open && <div id={id} className="mt-4">{children}</div>}
  </div>;
}

export function ChromeSetupView({
  installation, capabilityEnabled, requestedByTask, runtimeReady, extensionConnected,
  extensionPath, connecting, openingInstaller, error,
  onBack, onPrepare, onOpenInstaller, onDone, breadcrumb,
}: {
  installation: ChromeExtensionInstallation | undefined;
  capabilityEnabled: boolean;
  requestedByTask: boolean;
  runtimeReady: boolean;
  extensionConnected: boolean | undefined;
  extensionPath: string | null | undefined;
  connecting: boolean;
  openingInstaller: boolean;
  error?: string;
  onBack: () => void;
  onPrepare: () => void;
  onOpenInstaller: (target?: 'page' | 'folder') => void;
  onDone: () => void;
  breadcrumb?: string[];
}) {
  const { t } = useI18n();
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const installed = installation === 'installed';
  const taskReady = capabilityEnabled && runtimeReady && extensionConnected === true;
  const statusLabel = installed ? t.settings.capabilityChromeInstalled
    : installation === 'not-installed' ? t.settings.capabilityChromeNotInstalled
    : installation === 'unknown' ? t.settings.capabilityChromeInstallationUnknown
    : t.settings.capabilityChromeExtension;
  const guideButtonClass = 'border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] text-[var(--abu-text-primary)] text-minor shadow-none hover:bg-[var(--abu-bg-hover)]';
  const startInstallation = () => {
    setInstallGuideOpen(true);
    if ((!capabilityEnabled || !runtimeReady) && !connecting) onPrepare();
  };

  const guide = <section aria-label={t.settings.capabilityChromeSetupTitle} className="space-y-4">
    <p className="text-minor text-[var(--abu-text-muted)]">{t.settings.capabilityChromeGuideIntro}</p>
    <ol className="divide-y divide-[var(--abu-border)] rounded-xl border border-[var(--abu-border)] px-3">
      <li className="flex items-center gap-3 py-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-muted)]">1</span><div className="min-w-0 flex-1">
        <p className="text-body text-[var(--abu-text-primary)]">{t.settings.capabilityChromeGuidePage}</p>
      </div><Button variant="secondary" size="sm" className={guideButtonClass} disabled={openingInstaller} onClick={() => onOpenInstaller('page')}>{t.settings.capabilityChromeOpenExtensions}</Button></li>
      <li className="flex items-start gap-3 py-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-muted)]">2</span><p className="text-body text-[var(--abu-text-primary)]">{t.settings.capabilityChromeGuideDeveloper}</p></li>
      <li className="flex items-center gap-3 py-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-muted)]">3</span><div className="min-w-0 flex-1">
        <p className="text-body text-[var(--abu-text-primary)]">{t.settings.capabilityChromeGuideFolder}</p>
      </div><Button variant="secondary" size="sm" className={guideButtonClass} disabled={!extensionPath || openingInstaller} onClick={() => onOpenInstaller('folder')}>{t.settings.capabilityChromeOpenFolder}</Button></li>
    </ol>
    {extensionPath === null && <p role="alert" className="text-minor text-[var(--abu-warning)]">{t.settings.capabilityChromeResourceMissing}</p>}
  </section>;

  return <div className="space-y-7">
    <SetupHeader icon={Chrome} title={t.settings.capabilityMyChrome}
      description={t.settings.capabilityMyChromeSubtitle} onBack={onBack}
      backLabel={requestedByTask ? t.common.cancel : undefined}
      breadcrumb={requestedByTask ? undefined : breadcrumb} />
    <section aria-label={t.settings.capabilityChromeExtension} className="rounded-2xl border border-[var(--abu-border)] p-4">
      <div className="flex items-center gap-4">
        <p role="status" className="flex min-w-0 flex-1 items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
          <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', installed ? 'bg-[var(--abu-success-solid)]' : 'bg-[var(--abu-text-muted)]')} />
          {statusLabel}
        </p>
        {!installed && <Button variant="secondary" size="sm" className={guideButtonClass} disabled={openingInstaller} onClick={startInstallation}>{t.settings.capabilityChromeInstallExtension}</Button>}
      </div>
    </section>
    {installed ? <ChromeInstallationHelp>{guide}</ChromeInstallationHelp> : installGuideOpen && guide}
    {error && <p role="alert" className="text-minor text-[var(--abu-danger)]">{error}</p>}
    {requestedByTask && installed && !taskReady && <div className="space-y-3">
      <p className="text-minor text-[var(--abu-text-muted)]">{t.settings.capabilityChromeWaitingForBrowser}</p>
      {(!capabilityEnabled || !runtimeReady) && <Button disabled={connecting} onClick={onPrepare}>{t.settings.capabilityChromeConnect}</Button>}
    </div>}
    {requestedByTask && taskReady && <Button onClick={onDone}>{t.settings.capabilityReturnToTask}</Button>}
  </div>;
}

const computerSetupButtonClass =
  'h-8 rounded-md border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-3 text-minor text-[var(--abu-text-secondary)] shadow-none hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)] dark:border-[var(--abu-border)] dark:bg-[var(--abu-bg-muted)] dark:hover:bg-[var(--abu-bg-hover)]';

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
  modelIssue,
}: {
  modelIssue?: string;
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
  const permissionRows = [
    { icon: Eye, key: 'screenRead' as const, required: required.screenRead, ready: screenReady,
      title: t.settings.capabilityScreenRead, instruction: t.settings.capabilityComputerScreenShort },
    { icon: MousePointer2, key: 'uiControl' as const, required: required.uiControl, ready: controlReady,
      title: t.settings.capabilityUIControl, instruction: t.settings.capabilityComputerControlShort },
  ].filter(row => row.required);
  const completed = permissionRows.filter(row => row.ready).length;
  const ready = fullyReady && !restartRequired;
  const statusLabel = !enabled ? t.settings.capabilityStatusOff
    : restartRequired ? t.settings.capabilityPermissionGuideRestartTitle
      : ready ? modelIssue ? t.settings.capabilityStatusUnavailable : t.settings.capabilityComputerUsable : t.settings.capabilityStatusSetupRequired;
  const statusNote = !enabled
    ? requestedByTask ? t.settings.capabilityComputerTaskNeedsSetup : t.settings.capabilityComputerConfirmEnable
    : restartRequired
      ? requestedByTask ? t.settings.capabilityPermissionGuideRestartDesc : t.settings.capabilityComputerRestartNote
      : ready ? modelIssue || t.settings.capabilityComputerReadyNote
        : format(t.settings.capabilityComputerPermissionProgress, { completed, total: permissionRows.length });

  return (
    <div className="space-y-7">
      <SetupHeader icon={MonitorCog} title={t.settings.computerUse}
        description={t.settings.capabilityComputerSubtitle} onBack={onBack}
        backLabel={requestedByTask ? t.common.cancel : undefined}
        breadcrumb={requestedByTask ? undefined : breadcrumb} />

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--abu-border)] p-4">
        <div className="min-w-0 flex-1" aria-live="polite">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full',
              !enabled ? 'bg-[var(--abu-text-muted)]' : ready && !modelIssue ? 'bg-[var(--abu-success-solid)]' : 'bg-[var(--abu-warning-solid)]')} />
            <p className="text-body font-medium text-[var(--abu-text-primary)]">
              {checking ? t.settings.capabilityStatusChecking : statusLabel}
            </p>
          </div>
          <p className="mt-1 text-minor text-[var(--abu-text-muted)]">{statusNote}</p>
        </div>
        <div className="flex items-center gap-4">
          {enabled && restartRequired && onRelaunch ? (
            <Button variant="outline" className={computerSetupButtonClass} onClick={onRelaunch}>{t.settings.capabilityPermissionGuideRestart}</Button>
          ) : enabled && ready && requestedByTask ? (
            <Button variant="outline" className={computerSetupButtonClass} onClick={onDone}>{t.settings.capabilityReturnToTask}</Button>
          ) : enabled && !ready && !restartRequired ? (
            <Button variant="outline" className={computerSetupButtonClass} onClick={onRefresh} disabled={checking || requesting !== undefined}>
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
              {t.settings.capabilityCheckAgain}
            </Button>
          ) : null}
          <label className="inline-flex items-center">
            <span className="sr-only">{enabled ? t.settings.capabilityComputerDisable : t.settings.capabilityComputerSetupTitle}</span>
            <Toggle checked={enabled} onChange={enabled ? onDisable : onEnable} size="md" />
          </label>
        </div>
      </div>

      {enabled && !restartRequired && (
        <div className="space-y-4">
          {!ready && <p className="text-minor text-[var(--abu-text-muted)]">{t.settings.capabilityComputerSetupIntro}</p>}
          <section aria-label={t.settings.capabilityComputerSystemPermissions}
            className="divide-y divide-[var(--abu-border)] rounded-xl border border-[var(--abu-border)] px-3">
            {permissionRows.map(row => {
              const Icon = row.icon;
              return (
                <div key={row.key} className="py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-muted)]" aria-hidden="true">
                      <Icon className="h-4 w-4" />
                    </span>
                    <h4 className="min-w-0 flex-1 text-body font-medium text-[var(--abu-text-primary)]">{row.title}</h4>
                    {!row.ready && canOpenSystemSettings ? (
                      <Button variant="outline" className={computerSetupButtonClass} size="sm" onClick={() => onRequestPermission(row.key)} disabled={checking || requesting !== undefined}>
                        {requesting === row.key && <LoaderCircle className="h-4 w-4 animate-spin" />}
                        {t.settings.capabilityComputerAuthorize}
                      </Button>
                    ) : (
                      <span className="shrink-0 text-minor text-[var(--abu-text-muted)]">
                        {row.ready ? t.diagnostic.computerGranted : t.settings.capabilityPermissionMissing}
                      </span>
                    )}
                  </div>
                  {!row.ready && <p className="ml-9 mt-2 text-minor leading-relaxed text-[var(--abu-text-muted)]" aria-live="polite">
                    {canOpenSystemSettings ? row.instruction : t.settings.capabilityComputerPlatformHint}
                  </p>}
                </div>
              );
            })}
          </section>
        </div>
      )}

      {enabled && (
        <details className="text-minor text-[var(--abu-text-muted)]">
          <summary className="cursor-pointer">{t.settings.capabilityComputerViewHelp}</summary>
          <div className="mt-3 space-y-3 pl-4">
            {permissionRows.map(row => <p key={row.key}>{row.instruction}</p>)}
            {canOpenSystemSettings && <>
              <p>{t.settings.capabilityComputerMissingApp}</p>
              <Button variant="outline" className={computerSetupButtonClass} size="sm" onClick={onRevealApp} disabled={revealingApp}>
                {revealingApp ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                {t.settings.capabilityShowAppInFinder}
              </Button>
            </>}
          </div>
        </details>
      )}
      {children}
    </div>
  );
}
