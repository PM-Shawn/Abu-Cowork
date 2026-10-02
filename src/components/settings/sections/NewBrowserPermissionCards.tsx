import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { TextField } from '@/components/ds/text-field';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import { format, useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import { BROWSER_PERMISSION_RESOURCES, emptyBrowserSiteRule, parseBrowserPermissionConfig, type BrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import type { BrowserDefaultDecision, BrowserSiteOverride } from '@/core/permissions/browserPermissionDefaults';
import type { BrowserBackend } from './BrowserPermissionCards';
import { analyzeBrowserSitePermissionDraft } from './browserSitePermissionDraft';
import { CapabilityBreadcrumb } from './CapabilitySetupView';

function useResourceLabels() {
  const { t } = useI18n();
  return { browse: t.settings.browserBrowseLabel, upload: t.settings.browserOpClassUpload, script: t.settings.browserOpClassScripting };
}
function usePermissionOptions(inherit = false) {
  const { t } = useI18n();
  return [
    ...(inherit ? [{ value: 'inherit', label: t.settings.browserInherit }] : []),
    { value: 'allow', label: t.settings.browserOpStateAllow, description: t.settings.browserDefaultAllowDesc },
    { value: 'ask', label: t.settings.browserOpStateAsk, description: t.settings.browserOpStateAskDesc },
    { value: 'deny', label: t.settings.browserOpStateDeny, description: t.settings.browserOpStateDenyDesc },
  ];
}
function SaveStatus() {
  const { t } = useI18n();
  const status = useBrowserSaveStatusStore((s) => s.status.browserPermissionConfigV2);
  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => useBrowserSaveStatusStore.getState().clearBrowserSaveStatus('browserPermissionConfigV2'), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  if (!status || status === 'idle') return null;
  if (status === 'failed') {
    return <div className="mt-2">
      <InlineMessage tone="danger" action={<Button variant="plain" size="sm" onClick={() => useSettingsStore.getState().retryBrowserConfigSave('browserPermissionConfigV2')}>{t.settings.browserSaveRetry}</Button>}>
        {t.settings.browserSaveFailed}
      </InlineMessage>
    </div>;
  }
  return <p role="status" className="mt-2 text-ui-sm text-label-secondary">
    {status === 'saving' ? t.settings.browserSaveSaving : t.settings.browserSaveSaved}
  </p>;
}
export function NewBrowserPermissionCards({ onManageSites }: { backend: BrowserBackend; onManageSites: () => void }) {
  const { t } = useI18n();
  const config = parseBrowserPermissionConfig(useSettingsStore((s) => s.browserPermissionConfigV2));
  const labels = useResourceLabels();
  const options = usePermissionOptions();
  const descriptions = { browse: t.settings.browserBrowseDesc, upload: t.settings.browserUploadActionDesc, script: t.settings.browserScriptActionDesc };
  if (!config) return <InlineMessage tone="danger">{t.settings.browserConfigInvalid}</InlineMessage>;
  return <div className="space-y-6">
    <div>
      <SettingGroup title={t.settings.browserPermissionsTitle} description={t.settings.browserPermissionsSharedDesc}>
        {BROWSER_PERMISSION_RESOURCES.map((resource) => <div key={resource}>
          <SettingRow title={labels[resource]} description={descriptions[resource]}>
            <div className={SETTING_CONTROL_WIDTH.browserPermission}>
              <Select fullWidth label={labels[resource]} value={config.defaults[resource]} options={options} onValueChange={(value) => { void useSettingsStore.getState().setBrowserPermissionDefault(resource, value as BrowserDefaultDecision); }} />
            </div>
          </SettingRow>
          {resource === 'script' && config.defaults.script === 'allow' && <div className="pb-3"><InlineMessage tone="warning">{t.settings.browserUnattendedScriptRiskWarning}</InlineMessage></div>}
        </div>)}
      </SettingGroup>
      <SaveStatus />
    </div>
    <Pressable onClick={onManageSites} aria-label={t.settings.browserSitePermsTitle} className="flex w-full items-center gap-3 rounded-panel border border-separator p-4 text-left hover:bg-fill-hover">
      <span className="min-w-0 flex-1"><span className="block text-ui font-medium text-label">{t.settings.browserSitePermsTitle}</span><span className="mt-1 block text-ui-sm text-label-secondary">{format(t.settings.browserSiteRulesSummary, { count: Object.keys(config.sites).length + Object.values(config.embeddedSites).reduce((count, sites) => count + Object.keys(sites).length, 0) })}</span></span>
      <Icon icon={AppIcons.disclose} className="text-label-tertiary" />
    </Pressable>
  </div>;
}

function sameRule(a: BrowserSiteRule, b: BrowserSiteRule) {
  return a.blocked === b.blocked && a.browse === b.browse && a.upload === b.upload && a.script === b.script;
}

// One website of the list. The list can hold hundreds of them and the page re-renders on every
// character typed in the add window, so a row renders again only when its own website changes.
const SiteRow = memo(function SiteRow({ origin, embeddedIn, rule, busy, onStatus, onRemove }: {
  origin: string;
  embeddedIn?: string;
  rule: BrowserSiteRule;
  busy: boolean;
  onStatus: (origin: string, rule: BrowserSiteRule, status: string, embeddedIn?: string) => void;
  onRemove: (origin: string, rule: BrowserSiteRule, embeddedIn?: string) => void;
}) {
  const { t } = useI18n();
  // "Custom" opens a window. It opens after the list has closed and the focus is back on the
  // select, so the window returns the focus there. Opening the list again drops the request.
  const customAsked = useRef(false);
  const statusOptions = [
    { value: 'allowed', label: t.settings.browserSiteAllowBrowse, tone: 'success' as const },
    { value: 'blocked', label: t.settings.browserSiteAccessBlock, tone: 'danger' as const },
    { value: 'custom', label: t.settings.browserSiteCustom, icon: AppIcons.settings },
  ];
  const pick = (status: string) => {
    if (status === 'custom') customAsked.current = true;
    else onStatus(origin, rule, status, embeddedIn);
  };
  return <section aria-label={origin} className="flex items-center gap-4 py-3">
    <h4 className="min-w-0 flex-1 truncate text-ui font-medium text-label" title={origin}>{origin}{embeddedIn && <span className="block text-ui-sm font-normal text-label-secondary">{format(t.settings.browserEmbeddedScope, { origin: embeddedIn })}</span>}</h4>
    <div className={SETTING_CONTROL_WIDTH.siteAccess}>
      <Select
        fullWidth
        label={`${origin} ${t.settings.browserSiteAccess}`}
        value={rule.blocked ? 'blocked' : rule.browse === 'allow' && rule.upload === 'inherit' && rule.script === 'inherit' ? 'allowed' : 'custom'}
        options={embeddedIn ? statusOptions.filter((option) => option.value !== 'blocked') : statusOptions}
        disabled={busy}
        onOpenChange={(open) => { if (open) customAsked.current = false; }}
        onValueChange={pick}
        // A website that already has a custom rule shows Custom: picking it again edits the rule.
        onReselect={pick}
        onCloseAutoFocus={() => {
          if (!customAsked.current) return;
          customAsked.current = false;
          onStatus(origin, rule, 'custom', embeddedIn);
        }}
      />
    </div>
    <IconButton icon={AppIcons.delete} label={format(t.settings.browserSiteDeleteLabel, { origin })} disabled={busy} onClick={() => onRemove(origin, rule, embeddedIn)} />
  </section>;
}, (previous, next) => (
  previous.origin === next.origin && previous.embeddedIn === next.embeddedIn && previous.busy === next.busy
  && previous.onStatus === next.onStatus && previous.onRemove === next.onRemove && sameRule(previous.rule, next.rule)
));

export function NewBrowserSitePermissionsPage({ trail, onNavigate }: {
  trail: string[]; onNavigate: (index: number) => void;
}) {
  const { t } = useI18n();
  const config = parseBrowserPermissionConfig(useSettingsStore((s) => s.browserPermissionConfigV2));
  const labels = useResourceLabels();
  const options = usePermissionOptions();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ origin: string; embeddedIn?: string; expected: BrowserSiteRule; rule: BrowserSiteRule } | null>(null);
  const [error, setError] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<{ origin: string; embeddedIn?: string; expected: BrowserSiteRule } | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  useEffect(() => () => { operation.current += 1; }, []);
  const analysis = analyzeBrowserSitePermissionDraft(draft, 'denied', {});
  const browsingRule = (): BrowserSiteRule => ({ ...emptyBrowserSiteRule(), browse: 'allow' });
  function closeDialog() {
    operation.current += 1;
    setAdding(false); setEditing(null); setPendingRemoval(null); setError(''); setBusy(false);
  }
  async function saveRule(origin: string, rule: BrowserSiteRule, expected: BrowserSiteRule | null, embeddedIn?: string) {
    const token = ++operation.current;
    setBusy(true); setError('');
    const overrides = (value: BrowserSiteRule) => ({ browse: value.browse, upload: value.upload, script: value.script });
    const result = embeddedIn
      ? await useSettingsStore.getState().setBrowserEmbeddedRule(embeddedIn, origin, overrides(rule), expected ? overrides(expected) : null, () => token === operation.current)
      : await useSettingsStore.getState().setBrowserSiteRule(origin, rule, expected, () => token === operation.current);
    if (token !== operation.current) return;
    setBusy(false);
    if (result === 'saved') closeDialog();
    else setError(result === 'conflict' ? t.settings.browserSiteRuleConflict : t.settings.browserSaveFailed);
  }
  function addSite() {
    if (!analysis.normalizedOrigin || analysis.issue === 'credentials' || analysis.issue === 'invalid') {
      setError(analysis.issue === 'credentials' ? t.settings.browserSitePermsAddCredentials : t.settings.browserSitePermsAddInvalid);
      return;
    }
    if (config?.sites[analysis.normalizedOrigin]) { setError(t.settings.browserSiteAlreadyAdded); return; }
    void saveRule(analysis.normalizedOrigin, browsingRule(), null);
  }
  function changeStatus(origin: string, rule: BrowserSiteRule, status: string, embeddedIn?: string) {
    setError('');
    if (status === 'custom') {
      operation.current += 1;
      setEditing({ origin, embeddedIn, expected: { ...rule }, rule: { ...rule, blocked: false } });
    } else void saveRule(origin, status === 'blocked' ? { ...rule, blocked: true } : browsingRule(), rule, embeddedIn);
  }
  async function removeSite() {
    if (!pendingRemoval) return;
    const token = ++operation.current;
    setBusy(true); setError('');
    const saved = pendingRemoval.embeddedIn
      ? await useSettingsStore.getState().setBrowserEmbeddedRule(pendingRemoval.embeddedIn, pendingRemoval.origin, null, { browse: pendingRemoval.expected.browse, upload: pendingRemoval.expected.upload, script: pendingRemoval.expected.script }, () => token === operation.current) === 'saved'
      : await useSettingsStore.getState().removeBrowserSiteRule(pendingRemoval.origin, pendingRemoval.expected, () => token === operation.current);
    if (token !== operation.current) return;
    setBusy(false);
    if (saved) closeDialog(); else setError(t.settings.browserSaveFailed);
  }
  // Rows keep the same two callbacks for as long as the page lives; the first always runs the latest changeStatus.
  const latestChangeStatus = useRef(changeStatus);
  useLayoutEffect(() => { latestChangeStatus.current = changeStatus; });
  const changeRowStatus = useCallback((origin: string, rule: BrowserSiteRule, status: string, embeddedIn?: string) => {
    latestChangeStatus.current(origin, rule, status, embeddedIn);
  }, []);
  const askToRemove = useCallback((origin: string, rule: BrowserSiteRule, embeddedIn?: string) => {
    operation.current += 1; setError(''); setPendingRemoval({ origin, embeddedIn, expected: { ...rule } });
  }, []);
  if (!config) return <InlineMessage tone="danger">{t.settings.browserConfigInvalid}</InlineMessage>;
  const inheritedState = (resource: typeof BROWSER_PERMISSION_RESOURCES[number]) => {
    const site = editing?.embeddedIn ? config.sites[editing.origin] : undefined;
    if (site?.blocked) return 'deny';
    const override = site?.[resource];
    return override && override !== 'inherit' ? override : config.defaults[resource];
  };
  const rows = [
    ...Object.entries(config.sites).map(([origin, rule]) => ({ origin, rule, embeddedIn: undefined as string | undefined })),
    ...Object.entries(config.embeddedSites).flatMap(([embeddedIn, sites]) => Object.entries(sites).map(([origin, overrides]) => ({ origin, embeddedIn, rule: { ...overrides, blocked: false } }))),
  ].sort((a, b) => a.origin.localeCompare(b.origin));
  const errorMessage = error && <InlineMessage tone="danger">{error}</InlineMessage>;
  const closeWhenDismissed = (next: boolean) => { if (!next) closeDialog(); };
  return <div className="space-y-5">
    <CapabilityBreadcrumb trail={trail} onNavigate={onNavigate} />
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1"><h3 className="text-title text-label">{t.settings.browserSitePermsTitle}</h3><p className="mt-1 text-ui-sm text-label-secondary">{t.settings.browserSiteRulesDesc}</p></div>
      <Button variant="secondary" size="sm" icon={AppIcons.add} disabled={busy} onClick={() => { operation.current += 1; setDraft(''); setError(''); setAdding(true); }}>{t.settings.browserSitePermsAddButton}</Button>
    </div>
    {rows.length === 0 && <p className="py-4 text-ui-sm text-label-tertiary">{t.settings.browserSitePermsEmpty}</p>}
    {rows.length > 0 && <div>
      <div className="divide-y divide-separator rounded-panel border border-separator px-4">
        {rows.map(({ origin, rule, embeddedIn }) => <SiteRow key={`${embeddedIn ?? ""}:${origin}`} origin={origin} embeddedIn={embeddedIn} rule={rule} busy={busy} onStatus={changeRowStatus} onRemove={askToRemove} />)}
      </div>
      <p className="mt-2 px-4 text-ui-sm text-label-secondary">{t.settings.browserSiteRulesFootnote}</p>
    </div>}
    {!adding && !editing && !pendingRemoval && errorMessage}
    <SaveStatus />
    <Dialog open={adding} onOpenChange={closeWhenDismissed} title={t.settings.browserSiteAddTitle} size="md" dirty={draft.trim() !== ''}
      footer={<>
        {/* Cancel closes the way Escape does: a typed address is asked about first. */}
        <DialogClose asChild><Button variant="secondary">{t.common.cancel}</Button></DialogClose>
        <Button variant="primary" disabled={busy || !draft.trim()} onClick={addSite}>{t.settings.browserSitePermsAddButton}</Button>
      </>}>
      <div className="space-y-3">
        <label className="block text-ui text-label" htmlFor="browser-site-rule-url">{t.settings.browserSitePermsAddLabel}</label>
        <TextField id="browser-site-rule-url" value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError(''); }} placeholder={t.settings.browserSitePermsAddPlaceholder} />
        {analysis.normalizedOrigin && <p className="break-all text-ui-sm text-label-secondary">{t.settings.browserSitePermsEffectiveOrigin}: {analysis.normalizedOrigin}</p>}
        <p className="text-ui-sm text-label-secondary">{t.settings.browserSiteAddHint}</p>{errorMessage}
      </div>
    </Dialog>
    {editing && <Dialog open onOpenChange={closeWhenDismissed} title={t.settings.browserSiteCustomTitle} size="md"
      footer={<>
        <Button variant="secondary" onClick={closeDialog}>{t.common.cancel}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void saveRule(editing.origin, editing.rule, editing.expected, editing.embeddedIn)}>{t.settings.browserSitePermsSave}</Button>
      </>}>
      <div className="space-y-3">
        <p className="break-all text-ui text-label">{editing.origin}{editing.embeddedIn && <span className="block">{format(t.settings.browserEmbeddedScope, { origin: editing.embeddedIn })}</span>}</p>
        {editing.expected.blocked && <InlineMessage tone="warning">{t.settings.browserSiteUnblockOnSave}</InlineMessage>}
        {BROWSER_PERMISSION_RESOURCES.map((resource) => <div key={resource} className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-ui text-label-secondary">{labels[resource]}</span>
          <div className={SETTING_CONTROL_WIDTH.browserPermission}>
            <Select fullWidth value={editing.rule[resource]} options={[{ value: 'inherit', label: format(t.settings.browserSiteDefaultState, { state: options.find((option) => option.value === inheritedState(resource))!.label }) }, ...options]} disabled={busy} label={labels[resource]} onValueChange={(value) => setEditing({ ...editing, rule: { ...editing.rule, [resource]: value as BrowserSiteOverride } })} />
          </div>
        </div>)}
        {errorMessage}
      </div>
    </Dialog>}
    {/* Mounted only while asked: every frame of the question names the website it is about. */}
    {pendingRemoval && <Dialog open role="alertdialog" size="sm" onOpenChange={closeWhenDismissed} title={t.settings.browserSiteDeleteTitle} description={format(t.settings.browserSiteDeleteMessage, { origin: pendingRemoval.origin })}
      footer={<>
        <Button variant="secondary" onClick={closeDialog}>{t.common.cancel}</Button>
        <Button variant="danger" disabled={busy} onClick={() => void removeSite()}>{t.settings.browserSiteDeleteButton}</Button>
      </>}>
      {errorMessage}
    </Dialog>}
  </div>;
}
