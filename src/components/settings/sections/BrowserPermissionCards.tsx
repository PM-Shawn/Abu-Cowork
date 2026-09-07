import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Select, type SelectOption } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import type { BrowserConfigField } from '@/stores/browserConfigPersistence';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { summarizeBrowserAuthorization } from '@/core/permissions/browserAuthorizationSummary';
import {
  summarizeBrowserAutomations,
  type BrowserAutomationSource,
} from '@/core/permissions/browserAutomationOverview';
import { resolveUnattendedImTarget } from '@/core/im/approvalTarget';
import { isHighRiskUrl } from '@/core/permissions/highRiskSites';
import {
  browserOperationStatesFor,
  normalizeBrowserOrigin,
  type BrowserOperationClass,
  type BrowserOperationState,
  getSiteVerdict,
  type DecideBrowserOperationSiteVerdict,
} from '@/core/permissions/browserToolPolicy';
import {
  browserGatePreviewVerdict,
  evaluateBrowserGate,
} from '@/core/permissions/browserGateEvaluation';
import { reasonLabel } from '@/core/observability/browserRunReportCopy';
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
  const viaEmbedGrants = useSettingsStore((s) => s.browserSiteGrantViaEmbed);
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
  const authorization = summarizeBrowserAuthorization(
    sitePermissions,
    allowUnattended,
    viaEmbedGrants,
  );
  const highRisk = new Set(authorization.highRiskAllowed);
  const viaEmbed = new Set(authorization.viaEmbedAllowed);
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
        <BrowserSaveStatusLine field="browserSitePermissions" />
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
                {/*
                  R2-C-② — the other thing an 「始终允许」 row cannot imply: this
                  grant was given from another site's page, so an automatic task
                  will still be refused here. Re-choosing the verdict on this
                  row (or re-adding the origin above) promotes it to an ordinary
                  standing grant and the tag goes away.
                */}
                {sitePermissions[origin] === 'allowed' && viaEmbed.has(origin) && (
                  <span
                    className="shrink-0 rounded-md bg-[var(--abu-bg-hover)] px-1.5 py-0.5 text-caption text-[var(--abu-text-secondary)]"
                    title={t.settings.browserViaEmbedTagHint}
                  >
                    {t.settings.browserViaEmbedTag}
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

/** How long 「已保存」 stays on screen before the row goes quiet again. Long
 *  enough to notice, short enough not to become furniture. */
const SAVED_NOTICE_MS = 2500;

/**
 * S18 — whether the last edit to this field actually reached storage.
 *
 * An inline line, not a toast and not a card: it belongs to the control that
 * produced it, and a permission that failed to save is not something to
 * announce elsewhere and let the user hunt for.
 *
 * Silent in the ordinary case. `localStorage` is synchronous, so a successful
 * write is confirmed within the same tick — 「保存中」 exists because the state
 * machine has to be correct, not because it is interesting, and it is not
 * something a user will normally see. 「已保存」 shows briefly and leaves.
 * 「未能保存」 stays, with a retry, because it is the one state that needs an
 * answer from somebody.
 */
function BrowserSaveStatusLine({ field }: { field: BrowserConfigField }) {
  const { t } = useI18n();
  const status = useBrowserSaveStatusStore((s) => s.status[field]);
  const clearBrowserSaveStatus = useBrowserSaveStatusStore((s) => s.clearBrowserSaveStatus);
  const retryBrowserConfigSave = useSettingsStore((s) => s.retryBrowserConfigSave);

  useEffect(() => {
    // A failure is dismissed by fixing it, not by waiting.
    if (status !== 'saved') return;
    const timer = setTimeout(() => clearBrowserSaveStatus(field), SAVED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [status, field, clearBrowserSaveStatus]);

  if (status === undefined || status === 'idle') return null;
  if (status === 'saving') {
    return (
      <p className="mt-2 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {t.settings.browserSaveSaving}
      </p>
    );
  }
  if (status === 'saved') {
    return (
      <p className="mt-2 text-minor leading-relaxed text-[var(--abu-success)]">
        {t.settings.browserSaveSaved}
      </p>
    );
  }
  return (
    <p className="mt-2 flex items-center gap-2 text-minor leading-relaxed text-[var(--abu-danger)]">
      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
      {t.settings.browserSaveFailed}
      <button
        type="button"
        onClick={() => retryBrowserConfigSave(field)}
        className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
      >
        {t.settings.browserSaveRetry}
      </button>
    </p>
  );
}

/**
 * S11 — "which automations use the browser, and which one is misconfigured?",
 * directly under the master switch that governs them all.
 *
 * A read-only view over configuration that lives elsewhere: the approver and
 * the result channel belong to the individual task, so this reports a gap and
 * hands the user to the editor that owns it. It never copies an editor in here,
 * and 「去修改」 is a jump, not a second place to change the same thing.
 *
 * What it refuses to do is guess. Nothing statically declares "this task uses
 * the browser", so the only claim made is the one that IS knowable: whether the
 * automation's capability tier could reach a browser tool at all. Everything
 * else is 「运行时检查」, and a green summary is never shown in place of an
 * unknown (`summarizeBrowserAutomations` holds those rules).
 */
function BrowserAutomationOverviewCard() {
  const { t } = useI18n();
  const policy = useSettingsStore((s) => s.browserOperationPolicy);
  const allowUnattended = useSettingsStore((s) => s.allowUnattendedBrowser);
  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  // Round-3 R3-C. This is the THIRD screen that answers "where may a scheduled
  // task go?", and it arrived with a later settings batch after the other two were
  // taught about via-embed grants — so it counted them as reachable and
  // suppressed the "no allowed site" warning for a user who has none. The
  // summary already knows the rule; it just has to be told the marks.
  const viaEmbedGrants = useSettingsStore((s) => s.browserSiteGrantViaEmbed);
  const closeSystemSettings = useSettingsStore((s) => s.closeSystemSettings);
  const openAutomation = useSettingsStore((s) => s.openAutomation);
  const tasks = useScheduleStore((s) => s.tasks);
  const triggers = useTriggerStore((s) => s.triggers);
  const channels = useIMChannelStore((s) => s.channels);

  const overview = useMemo(() => summarizeBrowserAutomations({
    scheduledTasks: Object.values(tasks).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      outputChannelId: task.outputChannelId,
      outputChatIds: task.outputChatIds,
      outputUserIds: task.outputUserIds,
    })),
    triggers: Object.values(triggers).map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      status: trigger.status,
      action: trigger.action,
      output: trigger.output,
    })),
    imChannels: Object.values(channels ?? {}).map((channel) => ({
      id: channel.id,
      name: channel.name,
      capability: channel.capability,
      enabled: channel.enabled,
    })),
    policy,
    masterSwitchOn: allowUnattended,
    reachableSiteCount: summarizeBrowserAuthorization(
      sitePermissions, allowUnattended, viaEmbedGrants,
    ).reachableUnattended.length,
    // The REAL rule, not a copy of it: the same resolver the gate builds its
    // approval target from, so "this task has nobody to ask" here means exactly
    // what it will mean at 3am.
    hasApprovalTarget: (binding) => resolveUnattendedImTarget(binding) !== null,
  }), [tasks, triggers, channels, policy, allowUnattended, sitePermissions, viaEmbedGrants]);

  const sourceLabel: Record<BrowserAutomationSource, string> = {
    schedule: t.settings.browserAutomationSourceSchedule,
    trigger: t.settings.browserAutomationSourceTrigger,
    im: t.settings.browserAutomationSourceIm,
  };

  /** Leave settings and land in the editor that owns the missing binding. */
  const goFix = (entry: { source: BrowserAutomationSource; id: string }) => {
    if (entry.source === 'schedule') {
      useScheduleStore.getState().setSelectedTaskId(entry.id);
      useScheduleStore.getState().openEditor(entry.id);
      openAutomation('schedule');
    } else if (entry.source === 'trigger') {
      useTriggerStore.getState().setSelectedTriggerId(entry.id);
      useTriggerStore.getState().openEditor(entry.id);
      openAutomation('trigger');
    }
    // Settings is an overlay; leaving it open would put the editor behind it.
    closeSystemSettings();
  };

  return (
    <div className={settingsCardClass}>
      <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
        {t.settings.browserAutomationOverviewTitle}
      </h4>
      <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {overview.anyBrowserCapable
          ? format(t.settings.browserAutomationOverviewCounts, {
            schedule: overview.counts.schedule,
            trigger: overview.counts.trigger,
            im: overview.counts.im,
          })
          : t.settings.browserAutomationOverviewEmpty}
      </p>
      {/*
        With nothing that could use the browser, the prerequisites, the
        "nothing needs attention" line and the run-time note are all answers to
        a question nobody asked — four lines of text about an empty set. The
        subtitle above already said it.
      */}
      {overview.anyBrowserCapable && (
      <div className="mt-3 border-t border-[var(--abu-border)] pt-3">
        {overview.prerequisites.map((prerequisite) => (
          <p
            key={prerequisite}
            className="flex items-start gap-2 pb-2 text-minor leading-relaxed text-[var(--abu-warning)]"
          >
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {prerequisite === 'master-switch-off'
              ? t.settings.browserAutomationMasterOff
              : t.settings.browserAutomationNoAllowedSite}
          </p>
        ))}
        {overview.entries.length === 0 ? (
          <p className="text-minor leading-relaxed text-[var(--abu-text-tertiary)]">
            {/* "Nothing needs fixing" — deliberately NOT "everything will
                work". What runs depends on sign-in, files and the model too,
                none of which this card checked. */}
            {t.settings.browserAutomationOverviewClear}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--abu-border)]">
            {overview.entries.map((entry) => (
              <li key={`${entry.source}:${entry.id}`} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-[var(--abu-text-secondary)]" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="mt-0.5 block text-minor leading-relaxed text-[var(--abu-text-muted)]">
                    {sourceLabel[entry.source]}
                    {' · '}
                    {t.settings.browserAutomationNoApprover}
                    {!entry.active && ` · ${t.settings.browserAutomationPaused}`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => goFix(entry)}
                  className="shrink-0 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-2.5 py-1 text-minor font-medium text-[var(--abu-text-secondary)] transition-colors hover:bg-[var(--abu-bg-hover)]"
                >
                  {t.settings.browserAutomationFix}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="pt-2 text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserAutomationRuntimeCheck}
        </p>
      </div>
      )}
    </div>
  );
}

/** The three rows of the preview grid, in the order the policy card lists them. */
const PREVIEW_CLASSES: ReadonlyArray<{ opClass: BrowserOperationClass; labelKey: 'browserOpClassReadOnly' | 'browserOpClassInteractive' | 'browserOpClassUpload' | 'browserOpClassScripting' }> = [
  { opClass: 'read-only', labelKey: 'browserOpClassReadOnly' },
  { opClass: 'interactive', labelKey: 'browserOpClassInteractive' },
  // T5. The preview's whole promise is that it is the gate, so the row a user
  // most needs to see refused («为什么自动任务传不上去») has to be in it — a
  // preview that silently omits a class teaches a model of the settings that
  // is wrong by omission rather than by disagreement.
  { opClass: 'upload', labelKey: 'browserOpClassUpload' },
  { opClass: 'scripting', labelKey: 'browserOpClassScripting' },
];

/**
 * S12 — "what can Abu do on this site right now?", answered with zero side
 * effects.
 *
 * It opens nothing, fetches nothing, sends nothing and grants nothing: the
 * whole answer is `evaluateBrowserGate` applied to values already in the store.
 * That is also why it is trustworthy — it is the SAME function
 * `checkToolApproval` decides with, so the pane cannot quietly disagree with
 * what actually happens (`browserGateEvaluation.contract.test.ts` proves it
 * over the full matrix).
 *
 * Three things it deliberately does NOT claim:
 *  - the conversation grant is ignored. A 30-minute session grant is not a
 *    setting, and reporting 「允许」 because one happens to be live would answer
 *    a question about configuration with an accident of the last half hour.
 *  - sign-in state is not checked, because checking it means opening the site.
 *  - the automatic column assumes a run whose capability tier carries the
 *    browser. A specific trigger or chat channel may be tighter, and this pane
 *    has no task selected to read one from. Both are said once, in the caveat
 *    line, rather than as a badge per cell.
 */
function BrowserPermissionPreview() {
  const { t } = useI18n();
  const policy = useSettingsStore((s) => s.browserOperationPolicy);
  const allowUnattended = useSettingsStore((s) => s.allowUnattendedBrowser);
  const sitePermissions = useSettingsStore((s) => s.browserSitePermissions);
  const viaEmbedGrants = useSettingsStore((s) => s.browserSiteGrantViaEmbed);
  const permissionMode = useSettingsStore((s) => s.permissionMode);
  const [draft, setDraft] = useState('');

  const trimmed = draft.trim();
  const origin = trimmed === '' ? null : normalizeBrowserOrigin(trimmed);
  /**
   * The FULL address the user typed, kept alongside the origin rather than
   * replaced by it.
   *
   * The two facts the gate gathers are keyed differently and the preview has to
   * gather them the same way, or it disagrees with the gate at the one jump the
   * contract test cannot see (it constructs its own `siteVerdict` and never
   * runs this component). The stored verdict is per-ORIGIN; the high-risk
   * classifier reads the whole URL, because half of what it recognizes lives in
   * the PATH — `/checkout`, `/transfer`, `/wire` (`highRiskSites.ts`:
   * "the path patterns are what gives it reach beyond the list"). Handing it
   * `normalizeBrowserOrigin`'s output threw that half away silently — the
   * function ACCEPTS a URL with a path and returns the origin without
   * complaining — so `https://shop.example.com/checkout` previewed as an
   * ordinary site while the real gate refused it. Wrong in the direction that
   * matters least for safety and most for trust: the preview taught a model of
   * the settings that the gate does not honour.
   */
  const targetUrl = origin === null ? null : trimmed;

  const rows = useMemo(() => {
    if (origin === null || targetUrl === null) return null;
    /*
      Exactly what the gate does with a target URL: the stored verdict, unless
      the classifier calls the page money-movement or government — in which case
      high-risk REPLACES it, except on a site the user blocked (a block outranks
      everything and could only be loosened by the substitution).
    */
    /*
      Per RUN MODE, not once for both (round-2 R2-C-②): a grant minted through
      the merged embedded-region prompt is a full grant while somebody is
      watching and no standing grant at all for an automatic run, so the two
      columns of this table genuinely have different answers. Reading it
      through `getSiteVerdict` — the same function the gate reads it through —
      is what keeps that from being a second implementation.
    */
    const verdictFor = (runMode: 'attended' | 'unattended'): DecideBrowserOperationSiteVerdict => {
      const stored = getSiteVerdict(origin, sitePermissions, {
        viaEmbed: viaEmbedGrants,
        runMode,
      });
      return stored === 'denied'
        ? 'denied'
        : isHighRiskUrl(targetUrl) ? 'high-risk' : stored;
    };

    return PREVIEW_CLASSES.map(({ opClass, labelKey }) => ({
      opClass,
      label: t.settings[labelKey],
      cells: (['attended', 'unattended'] as const).map((runMode) => {
        const siteVerdict = verdictFor(runMode);
        const evaluation = evaluateBrowserGate({
          opClass,
          runMode,
          policy,
          masterSwitchUnattended: allowUnattended,
          siteVerdict,
          permissionMode,
          // No task is selected, so no ceiling can be read. Named in the
          // caveat line rather than guessed at.
          runPermissionCeiling: null,
          toolTargetsPage: true,
          originResolved: true,
          answersPageDialog: false,
          loginRequired: false,
          conversationGrant: false,
          confirmationChannelAvailable: true,
          originKnown: true,
        });
        const verdict = browserGatePreviewVerdict(evaluation);
        return {
          runMode,
          verdict,
          label: verdict === 'allow'
            ? t.settings.browserPreviewAllow
            : verdict === 'ask' ? t.settings.browserPreviewAsk : t.settings.browserPreviewDeny,
          // The refusal wording is the report card's own short label for the
          // same code — one vocabulary, so the pane and the morning card can
          // never explain the same block differently.
          why: verdict === 'deny' && evaluation.denialReason !== null
            ? reasonLabel(evaluation.denialReason, t)
            : verdict === 'ask'
              ? (evaluation.ask?.channel === 'im'
                ? t.settings.browserPreviewAskIm
                : t.settings.browserPreviewAskDialog)
              : t.settings.browserPreviewNoPrompt,
        };
      }),
    }));
  }, [origin, targetUrl, sitePermissions, viaEmbedGrants, policy, allowUnattended, permissionMode, t]);

  const verdictColor = (verdict: 'allow' | 'ask' | 'deny'): string =>
    verdict === 'allow'
      ? 'text-[var(--abu-success)]'
      : verdict === 'ask' ? 'text-[var(--abu-warning)]' : 'text-[var(--abu-danger)]';

  return (
    <div className="mt-3 border-t border-[var(--abu-border)] pt-3">
      <p className="text-body text-[var(--abu-text-secondary)]">
        {t.settings.browserPreviewTitle}
      </p>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t.settings.browserPreviewPlaceholder}
        aria-label={t.settings.browserPreviewTitle}
        className="mt-2 h-8 w-full"
      />
      {trimmed !== '' && origin === null && (
        <p className="mt-2 text-minor leading-relaxed text-[var(--abu-danger)]">
          {t.settings.browserPreviewInvalid}
        </p>
      )}
      {rows !== null && (
        // Wide content scrolls inside its own box rather than pushing the pane.
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[22rem] border-collapse text-left">
            <thead>
              <tr className="text-minor text-[var(--abu-text-muted)]">
                <th scope="col" className="w-1/4 py-1 font-normal" />
                <th scope="col" className="py-1 font-normal">{t.settings.browserPreviewAttended}</th>
                <th scope="col" className="py-1 font-normal">{t.settings.browserPreviewUnattended}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--abu-border)]">
              {rows.map((row) => (
                <tr key={row.opClass} className="align-top">
                  <th scope="row" className="py-2 pr-3 text-body font-normal text-[var(--abu-text-secondary)]">
                    {row.label}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.runMode} className="py-2 pr-3">
                      <span className={cn('block text-body font-medium', verdictColor(cell.verdict))}>
                        {cell.label}
                      </span>
                      <span className="mt-0.5 block text-minor leading-relaxed text-[var(--abu-text-muted)]">
                        {cell.why}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-minor leading-relaxed text-[var(--abu-text-muted)]">
        {t.settings.browserPreviewCaveat}
      </p>
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
  /**
   * Which of the two policy cards produced the notice below it.
   *
   * The save status is keyed by PERSISTED FIELD, and `browserOperationPolicy`
   * is one field holding all three rows — so both cards subscribe to the same
   * status and both used to light up 「已保存」 when either was touched.
   * Confirmation that lands on a control the user did not move is not
   * confirmation; it is noise that teaches them to stop reading the line.
   * Storage granularity is not the question here (splitting the field would
   * cost the atomic policy write for a cosmetic reason) — the question is
   * which control is being answered, and the component knows that.
   */
  const [editedPolicyCard, setEditedPolicyCard] = useState<'matrix' | 'scripting' | null>(null);

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
        // One sentence for every row, uploads included: since the 2026-09-07
        // ruling an unattended 「每次询问」 upload really does go to the IM
        // approval target, so the shared sentence is true here too.
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
    key: 'readOnly' | 'interactive' | 'scripting' | 'upload',
    opClass: BrowserOperationClass,
    rowLabel: string,
  ) => (
    <Select
      variant="inline"
      value={policy[key]}
      options={optionsFor(opClass)}
      onChange={(v) => {
        setEditedPolicyCard(key === 'scripting' ? 'scripting' : 'matrix');
        setBrowserOperationState(key, v as BrowserOperationState);
      }}
      ariaLabel={rowLabel}
      className={policySelectWidthClass}
    />
  );

  const matrixRows: Array<{
    key: 'readOnly' | 'interactive' | 'upload';
    opClass: BrowserOperationClass;
    label: string;
  }> = [
    { key: 'readOnly', opClass: 'read-only', label: t.settings.browserOpClassReadOnly },
    { key: 'interactive', opClass: 'interactive', label: t.settings.browserOpClassInteractive },
    // T5 — ONE MORE ROW, not one more card. §5② asks for upload to be visible
    // on its own line rather than folded into 「点击和填写」; it does not ask
    // for the weight scripting gets, and giving it a card with a warning
    // paragraph would make the ordinary case (attach a file to an OA form)
    // read as an advanced risk. Same list, same control, same width.
    { key: 'upload', opClass: 'upload', label: t.settings.browserOpClassUpload },
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
        <BrowserSaveStatusLine field="allowUnattendedBrowser" />
      </div>

      <BrowserAutomationOverviewCard />

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
          {editedPolicyCard === 'matrix' && (
            <BrowserSaveStatusLine field="browserOperationPolicy" />
          )}
        </div>

        <BrowserPermissionPreview />
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
          {editedPolicyCard === 'scripting' && (
            <BrowserSaveStatusLine field="browserOperationPolicy" />
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
