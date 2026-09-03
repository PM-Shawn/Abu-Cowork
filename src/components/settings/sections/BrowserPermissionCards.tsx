import { ChevronRight, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Select, type SelectOption } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { summarizeBrowserAuthorization } from '@/core/permissions/browserAuthorizationSummary';
import {
  browserOperationStatesFor,
  type BrowserOperationClass,
  type BrowserOperationState,
} from '@/core/permissions/browserToolPolicy';
import { CapabilityBreadcrumb, settingsCardClass } from './CapabilitySetupView';

/** Which browser channel a detail page is configuring. The permission cards
 *  are shared: the verdicts and the policy grid are one setting for both. */
export type BrowserBackend = 'builtin' | 'chrome';

/** Every policy select on this surface shares one width, so the two columns
 *  line up across the matrix card and the split-out scripting card. */
const policySelectWidthClass = 'w-28 shrink-0 justify-center';

/**
 * Persistent per-site browser-automation verdicts, written from the
 * confirmation dialog ("always allow this site" / "block this site"). Its own
 * page, reached from either channel's detail view: it is a record list, and a
 * record list is exactly the thing that should not sit on a decision screen.
 *
 * Every standing verdict is visible, switchable between allow and block, and
 * removable — removing restores ask-every-time for that site.
 */
export function BrowserSitePermissionsPage({
  trail,
  onNavigate,
}: {
  trail: string[];
  onNavigate: (index: number) => void;
}) {
  const { t } = useI18n();
  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  const allowUnattended = useSettingsStore((s) => s.allowUnattendedBrowser);
  const setBrowserSitePermission = useSettingsStore((s) => s.setBrowserSitePermission);
  const removeBrowserSitePermission = useSettingsStore((s) => s.removeBrowserSitePermission);
  const origins = Object.keys(sitePermissions).sort();
  // The explanation of what each verdict buys travels WITH the choice rather
  // than sitting in a paragraph above it.
  const verdictOptions: SelectOption[] = [
    {
      value: 'allowed',
      label: t.settings.browserSitePermsAllowed,
      description: t.settings.browserSitePermsAllowedDesc,
    },
    {
      value: 'denied',
      label: t.settings.browserSitePermsDenied,
      description: t.settings.browserSitePermsDeniedDesc,
    },
  ];
  // U5 authorization visibility: "allowed" is also what a run with nobody
  // watching acts on, and this list never said so. The summary answers "would
  // a scheduled task use these?" without making the user reconstruct it from
  // the master switch plus the high-risk rule.
  const authorization = summarizeBrowserAuthorization(sitePermissions, allowUnattended);
  const highRisk = new Set(authorization.highRiskAllowed);
  const reachSummary = !authorization.masterSwitchOn
    ? t.settings.browserUnattendedReachOff
    : authorization.reachableUnattended.length === 0
      ? t.settings.browserUnattendedReachNone
      : format(t.settings.browserUnattendedReachSummary, {
        count: authorization.reachableUnattended.length,
      });

  return (
    <div className="space-y-5">
      <CapabilityBreadcrumb trail={trail} onNavigate={onNavigate} />
      <div>
        <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserSitePermsTitle}
        </h3>
        <p className="mt-1 max-w-2xl text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserSitePermsDesc}
        </p>
        <p className="mt-1 max-w-2xl text-minor leading-relaxed text-[var(--abu-text-secondary)]">
          {reachSummary}
        </p>
      </div>
      {origins.length === 0 ? (
        <p className="border-t border-[var(--abu-border)] pt-3 text-minor text-[var(--abu-text-tertiary)]">
          {t.settings.browserSitePermsEmpty}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--abu-border)] border-t border-[var(--abu-border)]">
          {origins.map((origin) => (
            <li key={origin} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-body text-[var(--abu-text-secondary)]" title={origin}>
                {origin}
              </span>
              {/*
                The one thing the row cannot imply: a site the user explicitly
                allowed will STILL be asked about, because the page looks like
                money movement. Kept as a tag; the plain "an allowed site is
                allowed" tags were dropped as restatement.
              */}
              {sitePermissions[origin] === 'allowed' && highRisk.has(origin) && (
                <span className="shrink-0 rounded-md bg-[var(--abu-warning-bg)] px-1.5 py-0.5 text-caption text-[var(--abu-warning)]">
                  {t.settings.browserHighRiskTag}
                </span>
              )}
              <Select
                variant="inline"
                value={sitePermissions[origin]}
                options={verdictOptions}
                onChange={(v) => setBrowserSitePermission(origin, v as 'allowed' | 'denied')}
                className={cn(
                  policySelectWidthClass,
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
 * The browser permission surface, shared by both channels because the settings
 * themselves are shared: one operation policy, one master switch, one site
 * list, whichever browser ends up carrying the action out.
 *
 * `backend` therefore changes nothing about what is written — only whether the
 * Chrome channel's weaker safety net gets called out.
 *
 * Layout follows the shape of the decision:
 *  - the master switch is FIRST because it overrides everything under it (with
 *    it off, no automatic-task cell can allow anything, and that column is
 *    disabled to say so rather than showing settings that do nothing);
 *  - the two ordinary operation classes form a 2x2 grid;
 *  - scripting gets its own card. Under "automatic tasks" it is a degenerate
 *    cell (`browserOperationStatesFor` offers no "allow" there), and it is the
 *    one row a user should not skim past inside a grid.
 */
export function BrowserPermissionCards({
  backend,
  onManageSites,
}: {
  backend: BrowserBackend;
  onManageSites: () => void;
}) {
  const { t } = useI18n();
  const policy = useSettingsStore((s) => s.browserOperationPolicy);
  const allowUnattended = useSettingsStore((s) => s.allowUnattendedBrowser);
  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  const setBrowserOperationState = useSettingsStore((s) => s.setBrowserOperationState);
  const setAllowUnattendedBrowser = useSettingsStore((s) => s.setAllowUnattendedBrowser);

  const stateLabels: Record<BrowserOperationState, string> = {
    allow: t.settings.browserOpStateAllow,
    ask: t.settings.browserOpStateAsk,
    deny: t.settings.browserOpStateDeny,
  };
  const stateDescriptions: Record<BrowserOperationState, string> = {
    allow: t.settings.browserOpStateAllowDesc,
    ask: t.settings.browserOpStateAskDesc,
    deny: t.settings.browserOpStateDenyDesc,
  };
  // The option list is asked for per cell, not shared: unattended scripting
  // offers no "allow" (see `browserOperationStatesFor`), and offering one the
  // gate would refuse to honor is worse than offering fewer.
  const optionsFor = (
    runMode: 'attended' | 'unattended',
    opClass: BrowserOperationClass,
  ): SelectOption[] =>
    browserOperationStatesFor(runMode, opClass).map((state) => ({
      value: state,
      label: stateLabels[state],
      description: stateDescriptions[state],
    }));

  const attendedColumn = t.settings.browserOpPolicyColumnAttended;
  const unattendedColumn = t.settings.browserOpPolicyColumnUnattended;

  /** Both cards render their cells through here, so the matrix and the
   *  split-out scripting card write to the store through the same call. */
  const policyCell = (
    runMode: 'attended' | 'unattended',
    key: 'readOnly' | 'interactive' | 'scripting',
    opClass: BrowserOperationClass,
    rowLabel: string,
  ) => (
    <Select
      variant="inline"
      value={policy[runMode][key]}
      options={optionsFor(runMode, opClass)}
      onChange={(v) => setBrowserOperationState(runMode, key, v as BrowserOperationState)}
      disabled={runMode === 'unattended' && !allowUnattended}
      ariaLabel={`${rowLabel} · ${runMode === 'attended' ? attendedColumn : unattendedColumn}`}
      className={cn(
        policySelectWidthClass,
        runMode === 'unattended' && !allowUnattended && 'opacity-50',
      )}
    />
  );

  const matrixRows: Array<{
    key: 'readOnly' | 'interactive';
    opClass: BrowserOperationClass;
    label: string;
  }> = [
    { key: 'readOnly', opClass: 'read-only', label: t.settings.browserOpClassReadOnly },
    { key: 'interactive', opClass: 'interactive', label: t.settings.browserOpClassInteractive },
  ];

  const allowedCount = Object.values(sitePermissions).filter((v) => v === 'allowed').length;
  const deniedCount = Object.values(sitePermissions).filter((v) => v === 'denied').length;

  const columnHeader = (
    <div className="flex items-center gap-3 pb-1">
      <span className="min-w-0 flex-1" />
      <span className="w-28 shrink-0 text-center text-minor text-[var(--abu-text-muted)]">
        {attendedColumn}
      </span>
      <span className="w-28 shrink-0 text-center text-minor text-[var(--abu-text-muted)]">
        {unattendedColumn}
      </span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className={settingsCardClass}>
        <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserAutomaticTasksTitle}
        </h4>
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
      </div>

      <div className={settingsCardClass}>
        <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserOpPolicyTitle}
        </h4>
        <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserOpPolicyDesc}
        </p>
        {/*
          U6 — the two browser channels do not protect an automatic run
          equally, and only the built-in one can refuse BEFORE acting on an
          expired session. It is the ONE long-form warning left on this
          surface, and it is now attached to the channel it is about instead of
          being read by everyone including the people it does not apply to.
        */}
        {backend === 'chrome' && (
          <p className="mt-2 flex items-start gap-2 text-minor leading-relaxed text-[var(--abu-text-secondary)]">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-warning)]" />
            {t.settings.browserUnattendedChannelCaveat}
          </p>
        )}

        <div className="mt-3 border-t border-[var(--abu-border)] pt-3">
          {columnHeader}
          <ul className="divide-y divide-[var(--abu-border)]">
            {matrixRows.map((row) => (
              <li key={row.key} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-body text-[var(--abu-text-secondary)]">
                  {row.label}
                </span>
                {policyCell('attended', row.key, row.opClass, row.label)}
                {policyCell('unattended', row.key, row.opClass, row.label)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={settingsCardClass}>
        <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserOpClassScripting}
        </h4>
        <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserOpClassScriptingDesc}
        </p>
        <div className="mt-3 border-t border-[var(--abu-border)] pt-3">
          {columnHeader}
          <div className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1" />
            {policyCell('attended', 'scripting', 'scripting', t.settings.browserOpClassScripting)}
            {policyCell('unattended', 'scripting', 'scripting', t.settings.browserOpClassScripting)}
          </div>
        </div>
      </div>

      {/*
        Drills in, so it looks like every other thing on this page that drills
        in: the whole row is the control and a trailing chevron is the only
        affordance. A text button here would be the one exception on a surface
        whose rule is that there are none.
      */}
      <Button
        variant="ghost"
        onClick={onManageSites}
        aria-label={t.settings.browserSitePermsTitle}
        className={cn(
          settingsCardClass,
          'h-auto w-full items-center justify-start gap-3 whitespace-normal text-left hover:bg-[var(--abu-bg-hover)]',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold text-[var(--abu-text-primary)]">
            {t.settings.browserSitePermsTitle}
          </span>
          <span className="mt-1 block text-minor font-normal leading-relaxed text-[var(--abu-text-muted)]">
            {format(t.settings.browserSitePermsSummary, {
              allowed: allowedCount,
              denied: deniedCount,
            })}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-[var(--abu-text-muted)]" />
      </Button>
    </div>
  );
}
