import { useState } from 'react';
import { ChevronRight, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Select, type SelectOption } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { summarizeBrowserAuthorization } from '@/core/permissions/browserAuthorizationSummary';
import { isHighRiskUrl } from '@/core/permissions/highRiskSites';
import {
  browserOperationStatesFor,
  normalizeBrowserOrigin,
  type BrowserOperationClass,
  type BrowserOperationState,
} from '@/core/permissions/browserToolPolicy';
import { CapabilityBreadcrumb, settingsCardClass } from './CapabilitySetupView';

/** Which browser channel a detail page is configuring. The permission cards
 *  are shared: the verdicts and the policy grid are one setting for both. */
export type BrowserBackend = 'builtin' | 'chrome';

/**
 * Every dropdown on the capability pages is this wide — the policy rows, the
 * scripting card, the site list's verdicts and its add row — so the pane
 * reads as one control repeated rather than one per length of its own label.
 *
 * 13rem is picked to hold the longest option label with its description on
 * two lines in both locales; the menu is exactly this wide too (the `Select`
 * menu hugs its trigger), so a description wraps inside the menu instead of
 * setting its width.
 */
const policySelectWidthClass = 'w-52 shrink-0';

/**
 * Persistent per-site browser-automation verdicts, written from the
 * confirmation dialog ("always allow this site" / "block this site"). Its own
 * page, reached from either channel's detail view: it is a record list, and a
 * record list is exactly the thing that should not sit on a decision screen.
 *
 * Every standing verdict is visible, switchable between allow and block, and
 * removable — removing restores ask-every-time for that site.
 *
 * It is also where a verdict can be CREATED (F1, 2026-09-04). Until then the
 * only road to 「始终允许」 ran through the confirmation dialog, so a user
 * preparing a scheduled task had to run it attended, be refused, open the
 * conversation, click allow, and re-run — a deliberate failure as a setup
 * step. Codex's site-permissions page has the same add field, for the same
 * reason.
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

  const [draftUrl, setDraftUrl] = useState('');
  const [draftVerdict, setDraftVerdict] = useState<'allowed' | 'denied'>('allowed');
  const [addError, setAddError] = useState<string | null>(null);

  const submitDraft = () => {
    /*
      ONE normalizer for the whole app. The gate resolves a live tab's URL
      through `normalizeBrowserOrigin`, so a key typed here has to come out of
      the same function or the two spellings would never meet — a verdict
      stored under `https://Example.com./` would sit in the list looking
      authoritative while every call checked `https://example.com`. It also
      carries the rejections: non-http(s) and unparseable input come back null.
    */
    const origin = normalizeBrowserOrigin(draftUrl.trim());
    if (origin === null) {
      setAddError(t.settings.browserSitePermsAddInvalid);
      return;
    }
    /*
      A standing "always allow" for a bank is the exact artifact the high-risk
      classifier exists to prevent — the confirmation dialog already refuses to
      offer one there (`allowPersistentGrant: false`), and typing the address
      by hand must not be the way around that. BLOCKING one stays available:
      this rule only ever tightens. The reason shown is the dialog's reason
      minus its "check the page before you confirm" tail, which names an
      action this page does not offer.
    */
    if (draftVerdict === 'allowed' && isHighRiskUrl(origin)) {
      setAddError(t.settings.browserSitePermsAddHighRisk);
      return;
    }
    /*
      The SAME setter the rows use. The store is keyed by origin, so adding an
      origin that is already listed updates its verdict instead of minting a
      duplicate — which is also why this needs no "already exists" branch.
    */
    setBrowserSitePermission(origin, draftVerdict);
    setDraftUrl('');
    setAddError(null);
  };

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
      <div>
        {/*
          Same row rhythm as a verdict below it — address, verdict select of
          the same width, trailing control — so the list reads as one thing
          the user can both review and extend, not a record with a form bolted
          on top of it.
        */}
        <div className="flex items-center gap-3 border-t border-[var(--abu-border)] py-2">
          <Input
            value={draftUrl}
            onChange={(e) => {
              setDraftUrl(e.target.value);
              // A refusal about what was typed a moment ago is noise while the
              // user is typing the correction.
              if (addError !== null) setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submitDraft();
            }}
            placeholder={t.settings.browserSitePermsAddPlaceholder}
            aria-label={t.settings.browserSitePermsAddLabel}
            className="h-8 min-w-0 flex-1"
          />
          <Select
            variant="inline"
            value={draftVerdict}
            options={verdictOptions}
            onChange={(v) => {
              setDraftVerdict(v as 'allowed' | 'denied');
              if (addError !== null) setAddError(null);
            }}
            ariaLabel={t.settings.browserSitePermsAddVerdictLabel}
            className={policySelectWidthClass}
          />
          {/* Same surface as the rows' 「移除」 so the column of trailing
              controls reads as one, rather than this row shouting. */}
          <Button
            variant="outline"
            size="sm"
            onClick={submitDraft}
            className="shrink-0 border-[var(--abu-border)] bg-[var(--abu-bg-base)] font-medium"
          >
            {t.settings.browserSitePermsAddButton}
          </Button>
        </div>
        {addError !== null && (
          <p className="pb-2 text-minor leading-relaxed text-[var(--abu-danger)]">
            {addError}
          </p>
        )}
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
 *  - the master switch is FIRST because it overrides everything under it: with
 *    it off, nothing an automatic task asks for is allowed, whatever the rows
 *    below say;
 *  - the two ordinary operation classes are one row each, one dropdown each.
 *    They used to be a 2x2 grid — one column for «while you are here», one for
 *    «automatic tasks» — until the 2026-09-04 ruling («不应该分在不在场，只要
 *    得到了用户允许，都能做») made the permission one value that both contexts
 *    read;
 *  - scripting gets its own card: it is the one row a user should not skim
 *    past inside a grid, and the only one carrying a risk warning.
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
  /*
    F8 (2026-09-05) — 「允许」 does not mean the same thing on all three rows,
    so it no longer says the same thing either.

    Reading a page under 「允许」 really is unconditional: that row consults no
    site verdict at all. The two rows that ACT are scoped to the sites the user
    set to 「始终允许」 — a site with no standing verdict still opens a
    confirmation — so 「不再询问」 was simply false there. 「每次询问」 and
    「拒绝」 are true for every row and are shared as before.
  */
  const stateDescription = (
    opClass: BrowserOperationClass,
    state: BrowserOperationState,
  ): string => {
    switch (state) {
      case 'allow':
        return opClass === 'read-only'
          ? t.settings.browserOpStateAllowDesc
          : t.settings.browserOpStateAllowDescSiteScoped;
      case 'ask':
        return t.settings.browserOpStateAskDesc;
      case 'deny':
        return t.settings.browserOpStateDenyDesc;
    }
  };
  /*
    The option list is asked for per row, not shared — `browserOperationStatesFor`
    is the single seam that says which tiers a row may hold.

    Each description now covers BOTH execution contexts in one line, because
    the setting does: «ask every time» is a dialog while the user is here and
    an IM approval when a task is running alone. Before the 2026-09-04 ruling
    there were two columns and two descriptions per state; keeping the second
    sentence out of a paragraph above the control and inside the option is the
    part that did not change.
  */
  const optionsFor = (opClass: BrowserOperationClass): SelectOption[] =>
    browserOperationStatesFor(opClass).map((state) => ({
      value: state,
      label: stateLabels[state],
      description: stateDescription(opClass, state),
    }));

  /** Both cards render their rows through here, so the two ordinary classes
   *  and the split-out scripting card write to the store through the same
   *  call. */
  const policyRow = (
    key: 'readOnly' | 'interactive' | 'scripting',
    opClass: BrowserOperationClass,
    rowLabel: string,
  ) => (
    <Select
      variant="inline"
      value={policy[key]}
      options={optionsFor(opClass)}
      onChange={(v) => setBrowserOperationState(key, v as BrowserOperationState)}
      ariaLabel={rowLabel}
      className={policySelectWidthClass}
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
          <ul className="divide-y divide-[var(--abu-border)]">
            {matrixRows.map((row) => (
              <li key={row.key} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-body text-[var(--abu-text-secondary)]">
                  {row.label}
                </span>
                {policyRow(row.key, row.opClass, row.label)}
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
          <div className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1" />
            {policyRow('scripting', 'scripting', t.settings.browserOpClassScripting)}
          </div>
          {/*
            The warning that comes WITH the choice, not before it: one line,
            directly under the select that produced it. This is the shape Codex
            gives its own high-risk switch — the risk is stated where the
            decision is made, not hidden behind an ⓘ or a dialog.

            It used to be gated on the automatic-tasks master switch, on the
            reasoning that an attended script was asked about every time
            whatever this row said, so an 'allow' stored with the switch off
            was an intention rather than a live risk. The 2026-09-04 R1 fix
            ended that: 「允许」 now really stops asking on 「始终允许」 sites
            while the user is watching, master switch or not. So the moment
            this row reads 'allow' something can happen without a prompt, and
            the line has to be there — the copy names both contexts because
            the setting does.
          */}
          {policy.scripting === 'allow' && (
            <p className="flex items-start gap-2 text-minor leading-relaxed text-[var(--abu-warning)]">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t.settings.browserUnattendedScriptRiskWarning}
            </p>
          )}
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
