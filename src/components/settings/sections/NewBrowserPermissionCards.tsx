import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, Settings2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { format, useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import { BROWSER_PERMISSION_RESOURCES, emptyBrowserSiteRule, parseBrowserPermissionConfig, type BrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import type { BrowserDefaultDecision, BrowserSiteOverride } from '@/core/permissions/browserPermissionDefaults';
import type { BrowserBackend } from './BrowserPermissionCards';
import { analyzeBrowserSitePermissionDraft } from './browserSitePermissionDraft';
import { CapabilityBreadcrumb, settingsCardClass } from './CapabilitySetupView';
import SettingsConfirmDialog from '../SettingsConfirmDialog';

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
  return <p role="status" className={`mt-2 text-minor ${status === 'failed' ? 'text-[var(--abu-danger)]' : 'text-[var(--abu-text-muted)]'}`}>
    {status === 'failed' ? t.settings.browserSaveFailed : status === 'saving' ? t.settings.browserSaveSaving : t.settings.browserSaveSaved}
    {status === 'failed' && <Button variant="link" size="sm" onClick={() => useSettingsStore.getState().retryBrowserConfigSave('browserPermissionConfigV2')}>{t.settings.browserSaveRetry}</Button>}
  </p>;
}
export function NewBrowserPermissionCards({ onManageSites }: { backend: BrowserBackend; onManageSites: () => void }) {
  const { t } = useI18n();
  const config = parseBrowserPermissionConfig(useSettingsStore((s) => s.browserPermissionConfigV2));
  const labels = useResourceLabels();
  const options = usePermissionOptions();
  const descriptions = { browse: t.settings.browserBrowseDesc, upload: t.settings.browserUploadActionDesc, script: t.settings.browserScriptActionDesc };
  if (!config) return <p role="alert">{t.settings.browserConfigInvalid}</p>;
  return <div className="space-y-6">
    <section>
      <h4 className="mb-2 text-body font-medium text-[var(--abu-text-primary)]">{t.settings.browserPermissionsTitle}</h4>
      <p className="text-minor leading-relaxed text-[var(--abu-text-muted)]">{t.settings.browserPermissionsSharedDesc}</p>
      <ul className="mt-3 divide-y divide-[var(--abu-border)] rounded-lg border border-[var(--abu-border)] px-4">
        {BROWSER_PERMISSION_RESOURCES.map((resource) => <li key={resource} className="py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1"><p className="text-body text-[var(--abu-text-secondary)]">{labels[resource]}</p><p className="mt-0.5 text-minor text-[var(--abu-text-muted)]">{descriptions[resource]}</p></div>
            <Select variant="inline" value={config.defaults[resource]} options={options} ariaLabel={labels[resource]} className="w-52 shrink-0" onChange={(value) => { void useSettingsStore.getState().setBrowserPermissionDefault(resource, value as BrowserDefaultDecision); }} />
          </div>
          {resource === 'script' && config.defaults.script === 'allow' && <p className="mt-2 flex items-start gap-2 text-minor text-[var(--abu-warning)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t.settings.browserUnattendedScriptRiskWarning}</p>}
        </li>)}
      </ul>
      <SaveStatus />
    </section>
    <Button variant="ghost" onClick={onManageSites} aria-label={t.settings.browserSitePermsTitle} className={`${settingsCardClass} h-auto w-full justify-start gap-3 whitespace-normal bg-transparent text-left hover:bg-[var(--abu-bg-hover)]`}>
      <span className="min-w-0 flex-1"><span className="block text-body font-semibold">{t.settings.browserSitePermsTitle}</span><span className="mt-1 block text-minor font-normal text-[var(--abu-text-muted)]">{format(t.settings.browserSiteRulesSummary, { count: Object.keys(config.sites).length + Object.values(config.embeddedSites).reduce((count, sites) => count + Object.keys(sites).length, 0) })}</span></span><ChevronRight className="h-4 w-4 shrink-0" />
    </Button>
  </div>;
}

// A Select menu is portalled outside the dialog. Consume its dismissal keys
// before the outer confirmation's window capture listener, only while open.
function SiteRuleFields({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      const trigger = root.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"][aria-controls]');
      if (!trigger) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      trigger.click();
      trigger.focus();
      if (event.key === 'Tab') {
        const controls = Array.from(root.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
        const index = controls.indexOf(trigger);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return <div ref={root} className="space-y-3">{children}</div>;
}

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
  if (!config) return <p role="alert">{t.settings.browserConfigInvalid}</p>;
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
  const statusOptions = [
    { value: 'allowed', label: t.settings.browserSiteAllowBrowse, icon: <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--abu-success)]" /> },
    { value: 'blocked', label: t.settings.browserSiteAccessBlock, icon: <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--abu-danger-solid)]" /> },
    { value: 'custom', label: t.settings.browserSiteCustom, icon: <Settings2 aria-hidden="true" className="size-3.5 shrink-0 text-[var(--abu-text-muted)]" /> },
  ];
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
  const errorMessage = error && <p role="alert" className="mt-2 text-minor text-[var(--abu-danger)]">{error}</p>;
  return <div className="space-y-5">
    <CapabilityBreadcrumb trail={trail} onNavigate={onNavigate} />
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1"><h3 className="text-h-sm text-[var(--abu-text-primary)]">{t.settings.browserSitePermsTitle}</h3><p className="mt-1 text-minor text-[var(--abu-text-muted)]">{t.settings.browserSiteRulesDesc}</p></div>
      <Button variant="ghost" size="sm" className="rounded-xl bg-[var(--abu-bg-muted)] px-3 hover:bg-[var(--abu-bg-hover)]" disabled={busy} onClick={() => { operation.current += 1; setDraft(''); setError(''); setAdding(true); }}><Plus className="size-4" />{t.settings.browserSitePermsAddButton}</Button>
    </div>
    {rows.length === 0 && <p className="py-4 text-minor text-[var(--abu-text-muted)]">{t.settings.browserSitePermsEmpty}</p>}
    {rows.length > 0 && <div>
    <div className="divide-y divide-[var(--abu-border)] rounded-2xl border border-[var(--abu-border)] px-4">{rows.map(({ origin, rule, embeddedIn }) => <section key={`${embeddedIn ?? ""}:${origin}`} aria-label={origin} className="flex min-h-16 items-center gap-4 py-3">
      <h4 className="min-w-0 flex-1 truncate text-body font-medium text-[var(--abu-text-primary)]" title={origin}>{origin}{embeddedIn && <span className="block text-minor font-normal text-[var(--abu-text-muted)]">{format(t.settings.browserEmbeddedScope, { origin: embeddedIn })}</span>}</h4>
      <Select variant="inline" ariaLabel={`${origin} ${t.settings.browserSiteAccess}`} value={rule.blocked ? 'blocked' : rule.browse === 'allow' && rule.upload === 'inherit' && rule.script === 'inherit' ? 'allowed' : 'custom'} options={embeddedIn ? statusOptions.filter((option) => option.value !== 'blocked') : statusOptions} disabled={busy} onChange={(value) => changeStatus(origin, rule, value, embeddedIn)} className="w-48 shrink-0 [&>button]:h-8 [&>button]:rounded-xl [&>button]:py-0 [&>button]:font-medium" />
      <Button variant="ghost" size="icon-sm" className="text-[var(--abu-text-muted)]" disabled={busy} aria-label={format(t.settings.browserSiteDeleteLabel, { origin })} onClick={() => { operation.current += 1; setError(''); setPendingRemoval({ origin, embeddedIn, expected: { ...rule } }); }}><Trash2 className="h-4 w-4 text-[var(--abu-text-muted)]" /></Button>
    </section>)}</div>
    <p className="mt-2 px-4 text-minor text-[var(--abu-text-muted)]">{t.settings.browserSiteRulesFootnote}</p>
    </div>}
    {!adding && !editing && !pendingRemoval && errorMessage}
    <SaveStatus />
    <SettingsConfirmDialog open={adding} title={t.settings.browserSiteAddTitle} confirmText={t.settings.browserSitePermsAddButton} cancelText={t.common.cancel} confirmDisabled={busy || !draft.trim()} onCancel={closeDialog} onConfirm={addSite} message={<div className="space-y-3">
      <label className="block text-body text-[var(--abu-text-primary)]" htmlFor="browser-site-rule-url">{t.settings.browserSitePermsAddLabel}</label>
      <Input id="browser-site-rule-url" value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError(''); }} placeholder={t.settings.browserSitePermsAddPlaceholder} />
      {analysis.normalizedOrigin && <p className="break-all text-minor text-[var(--abu-text-muted)]">{t.settings.browserSitePermsEffectiveOrigin}: {analysis.normalizedOrigin}</p>}
      <p className="text-minor text-[var(--abu-text-muted)]">{t.settings.browserSiteAddHint}</p>{errorMessage}
    </div>} />
    {editing && <SettingsConfirmDialog open title={t.settings.browserSiteCustomTitle} confirmText={t.settings.browserSitePermsSave} cancelText={t.common.cancel} confirmDisabled={busy} onCancel={closeDialog} onConfirm={() => void saveRule(editing.origin, editing.rule, editing.expected, editing.embeddedIn)} message={<SiteRuleFields>
      <p className="break-all text-body text-[var(--abu-text-primary)]">{editing.origin}{editing.embeddedIn && <span className="block">{format(t.settings.browserEmbeddedScope, { origin: editing.embeddedIn })}</span>}</p>
      {editing.expected.blocked && <p className="text-minor text-[var(--abu-warning)]">{t.settings.browserSiteUnblockOnSave}</p>}
      {BROWSER_PERMISSION_RESOURCES.map((resource) => <div key={resource} className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-body text-[var(--abu-text-secondary)]">{labels[resource]}</span>
        <Select variant="inline" value={editing.rule[resource]} options={[{ value: 'inherit', label: format(t.settings.browserSiteDefaultState, { state: options.find((option) => option.value === inheritedState(resource))!.label }) }, ...options]} disabled={busy} ariaLabel={labels[resource]} className="w-52 shrink-0" onChange={(value) => setEditing({ ...editing, rule: { ...editing.rule, [resource]: value as BrowserSiteOverride } })} />
      </div>)}
      {errorMessage}
    </SiteRuleFields>} />}
    <SettingsConfirmDialog open={pendingRemoval !== null} title={t.settings.browserSiteDeleteTitle} message={<>{format(t.settings.browserSiteDeleteMessage, { origin: pendingRemoval?.origin ?? '' })}{errorMessage}</>} confirmText={t.settings.browserSiteDeleteButton} cancelText={t.common.cancel} variant="danger" confirmDisabled={busy} onCancel={closeDialog} onConfirm={() => void removeSite()} />
  </div>;
}
