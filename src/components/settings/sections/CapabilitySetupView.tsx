import { useState, type ComponentProps } from 'react';
import type { ChromeExtensionInstallation } from '@/core/capabilityPlugins/chromeSetup';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Disclosure } from '@/components/ds/disclosure';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import type {
  ComputerUsePermission,
  ComputerUsePermissionRequirements,
  ComputerUsePermissions,
} from '@/core/agent/computerUsePermission';

type IconGlyph = ComponentProps<typeof Icon>['icon'];

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

const BADGE_TONE = { ready: 'success', attention: 'warning', neutral: 'neutral' } as const;

export function StatusBadge({
  label,
  tone,
  checking = false,
  spinning = false,
}: {
  label: string;
  tone: StatusBadgeTone;
  checking?: boolean;
  /** A page has one spinner: its status row passes this. The overview cards can
   *  all be checking at once, so they leave it off and show a still icon. */
  spinning?: boolean;
}) {
  if (checking && spinning) return <Spinner size="sm" label={label} />;
  if (checking) {
    return (
      <Tag>
        <Icon icon={AppIcons.loading} size="sm" />
        {label}
      </Tag>
    );
  }
  return <Tag tone={BADGE_TONE[tone]}>{label}</Tag>;
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
    <div className="flex flex-wrap items-center gap-3 border-y border-separator py-4">
      <StatusBadge label={label} tone={tone} checking={checking} spinning />
      <span className="min-w-0 flex-1 text-ui-sm text-label-secondary">
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
    <nav className="mb-5 flex flex-wrap items-center gap-1 text-ui-sm text-label-secondary">
      {trail.map((segment, index) => {
        const isLeaf = index === trail.length - 1;
        return (
          <span key={`${segment}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && <Icon icon={AppIcons.disclose} size="sm" />}
            {isLeaf ? (
              <span className="text-label">{segment}</span>
            ) : (
              <Pressable
                onClick={() => onNavigate(index)}
                // The link one step up is the page's way back: it takes the focus when the page opens.
                data-capability-back={index === trail.length - 2 ? '' : undefined}
                aria-label={index === 0 ? t.settings.capabilityBackToOverview : segment}
                className="rounded-control text-ui-sm text-label-secondary hover:text-label"
              >
                {segment}
              </Pressable>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function SetupHeader({
  icon,
  title,
  description,
  onBack,
  backLabel,
  breadcrumb,
  action,
}: {
  icon: IconGlyph;
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
        <div className="mb-5">
          <Button variant="plain" size="sm" icon={AppIcons.back} data-capability-back="" onClick={onBack}>
            {backLabel ?? t.settings.capabilityBackToOverview}
          </Button>
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-fill text-label-secondary">
          <Icon icon={icon} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-title text-label">{title}</h3>
          <p className="mt-1 max-w-2xl text-ui-sm text-label-secondary">
            {description}
          </p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/**
 * The mark in front of a state line. A state that works or needs attention gets
 * its status shape; "off" and "not there yet" get a hollow dot. All of them fill
 * the same box as the spinner that replaces them during a check, so the words
 * beside it do not move.
 */
function StateMark({ tone }: { tone: 'off' | 'success' | 'warning' }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
      {tone === 'off'
        ? <span className="size-2 rounded-full border border-control-border" />
        : <StatusIcon tone={tone} size="sm" />}
    </span>
  );
}

const stepNumberClass = 'flex size-6 shrink-0 items-center justify-center rounded-full bg-fill text-ui-sm text-label-secondary';

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
  const startInstallation = () => {
    setInstallGuideOpen(true);
    if ((!capabilityEnabled || !runtimeReady) && !connecting) onPrepare();
  };

  const guide = <section aria-label={t.settings.capabilityChromeSetupTitle} className="space-y-4">
    <p className="text-ui-sm text-label-secondary">{t.settings.capabilityChromeGuideIntro}</p>
    <ol className="divide-y divide-separator rounded-panel border border-separator px-3">
      <li className="flex items-center gap-3 py-3"><span className={stepNumberClass}>1</span><div className="min-w-0 flex-1">
        <p className="text-ui text-label">{t.settings.capabilityChromeGuidePage}</p>
      </div><Button variant="secondary" size="sm" disabled={openingInstaller} onClick={() => onOpenInstaller('page')}>{t.settings.capabilityChromeOpenExtensions}</Button></li>
      <li className="flex items-start gap-3 py-3"><span className={stepNumberClass}>2</span><p className="text-ui text-label">{t.settings.capabilityChromeGuideDeveloper}</p></li>
      <li className="flex items-center gap-3 py-3"><span className={stepNumberClass}>3</span><div className="min-w-0 flex-1">
        <p className="text-ui text-label">{t.settings.capabilityChromeGuideFolder}</p>
      </div><Button variant="secondary" size="sm" disabled={!extensionPath || openingInstaller} onClick={() => onOpenInstaller('folder')}>{t.settings.capabilityChromeOpenFolder}</Button></li>
    </ol>
    {extensionPath === null && <InlineMessage tone="warning">{t.settings.capabilityChromeResourceMissing}</InlineMessage>}
  </section>;

  return <div className="space-y-6">
    <SetupHeader icon={AppIcons.chrome} title={t.settings.capabilityMyChrome}
      description={t.settings.capabilityMyChromeSubtitle} onBack={onBack}
      backLabel={requestedByTask ? t.common.cancel : undefined}
      breadcrumb={requestedByTask ? undefined : breadcrumb} />
    <section aria-label={t.settings.capabilityChromeExtension} className="rounded-panel border border-separator p-4">
      <div className="flex items-center gap-4">
        <p role="status" className="flex min-w-0 flex-1 items-center gap-2 text-ui font-medium text-label">
          <StateMark tone={installed ? 'success' : 'off'} />
          {statusLabel}
        </p>
        {!installed && <Button variant="secondary" size="sm" disabled={openingInstaller} onClick={startInstallation}>{t.settings.capabilityChromeInstallExtension}</Button>}
      </div>
    </section>
    {installed ? <Disclosure title={t.settings.capabilityChromeSetupHelp}>{guide}</Disclosure> : installGuideOpen && guide}
    {error && <InlineMessage tone="danger">{error}</InlineMessage>}
    {requestedByTask && installed && !taskReady && <div className="space-y-3">
      <p className="text-ui-sm text-label-secondary">{t.settings.capabilityChromeWaitingForBrowser}</p>
      {(!capabilityEnabled || !runtimeReady) && <Button variant="primary" disabled={connecting} onClick={onPrepare}>{t.settings.capabilityChromeConnect}</Button>}
    </div>}
    {requestedByTask && taskReady && <Button variant="primary" onClick={onDone}>{t.settings.capabilityReturnToTask}</Button>}
  </div>;
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
    { icon: AppIcons.screenRead, key: 'screenRead' as const, required: required.screenRead, ready: screenReady,
      title: t.settings.capabilityScreenRead, instruction: t.settings.capabilityComputerScreenShort },
    { icon: AppIcons.uiControl, key: 'uiControl' as const, required: required.uiControl, ready: controlReady,
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
    <div className="space-y-6">
      <SetupHeader icon={AppIcons.computerUse} title={t.settings.computerUse}
        description={t.settings.capabilityComputerSubtitle} onBack={onBack}
        backLabel={requestedByTask ? t.common.cancel : undefined}
        breadcrumb={requestedByTask ? undefined : breadcrumb} />

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-separator p-4">
        <div className="min-w-0 flex-1" aria-live="polite">
          {/* The page's one spinner: while a check runs it stands in for the state. */}
          {checking ? (
            <Spinner size="sm" labelSize="ui" label={t.settings.capabilityStatusChecking} />
          ) : (
            <div className="flex items-center gap-2">
              <StateMark tone={!enabled ? 'off' : ready && !modelIssue ? 'success' : 'warning'} />
              <p className="text-ui font-medium text-label">{statusLabel}</p>
            </div>
          )}
          <p className="mt-1 text-ui-sm text-label-secondary">{statusNote}</p>
        </div>
        <div className="flex items-center gap-4">
          {enabled && restartRequired && onRelaunch ? (
            <Button variant="secondary" onClick={onRelaunch}>{t.settings.capabilityPermissionGuideRestart}</Button>
          ) : enabled && ready && requestedByTask ? (
            <Button variant="secondary" onClick={onDone}>{t.settings.capabilityReturnToTask}</Button>
          ) : enabled && !ready && !restartRequired ? (
            <Button variant="secondary" icon={AppIcons.retry} onClick={onRefresh} disabled={checking || requesting !== undefined}>
              {t.settings.capabilityCheckAgain}
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={enabled ? onDisable : onEnable}
            aria-label={enabled ? t.settings.capabilityComputerDisable : t.settings.capabilityComputerSetupTitle}
          />
        </div>
      </div>

      {enabled && !restartRequired && (
        <div className="space-y-4">
          {!ready && <p className="text-ui-sm text-label-secondary">{t.settings.capabilityComputerSetupIntro}</p>}
          <section aria-label={t.settings.capabilityComputerSystemPermissions}
            className="divide-y divide-separator rounded-panel border border-separator px-3">
            {permissionRows.map(row => (
              <div key={row.key} className="flex gap-3 py-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fill text-label-secondary" aria-hidden="true">
                  <Icon icon={row.icon} size="sm" />
                </span>
                <div className="min-w-0 flex-1">
                  {/* The title, its action and its state share this parent: readers find the
                      action through the heading. */}
                  <div className="flex min-h-6 items-center gap-3">
                    <h4 className="min-w-0 flex-1 text-ui font-medium text-label">{row.title}</h4>
                    {!row.ready && canOpenSystemSettings ? (
                      // Waiting for the user to answer the system's own prompt: a still icon.
                      <Button variant="secondary" size="sm" icon={requesting === row.key ? AppIcons.loading : undefined}
                        onClick={() => onRequestPermission(row.key)} disabled={checking || requesting !== undefined}>
                        {t.settings.capabilityComputerAuthorize}
                      </Button>
                    ) : (
                      <span className="shrink-0 text-ui-sm text-label-secondary">
                        {row.ready ? t.diagnostic.computerGranted : t.settings.capabilityPermissionMissing}
                      </span>
                    )}
                  </div>
                  {!row.ready && <p className="mt-2 text-ui-sm text-label-secondary" aria-live="polite">
                    {canOpenSystemSettings ? row.instruction : t.settings.capabilityComputerPlatformHint}
                  </p>}
                </div>
              </div>
            ))}
          </section>
        </div>
      )}

      {enabled && (
        <Disclosure title={t.settings.capabilityComputerViewHelp}>
          <div className="space-y-3 text-ui-sm text-label-secondary">
            {permissionRows.map(row => <p key={row.key}>{row.instruction}</p>)}
            {canOpenSystemSettings && <>
              <p>{t.settings.capabilityComputerMissingApp}</p>
              <Button variant="secondary" size="sm" icon={revealingApp ? AppIcons.loading : AppIcons.folderOpen}
                onClick={onRevealApp} disabled={revealingApp}>
                {t.settings.capabilityShowAppInFinder}
              </Button>
            </>}
          </div>
        </Disclosure>
      )}
      {children}
    </div>
  );
}
