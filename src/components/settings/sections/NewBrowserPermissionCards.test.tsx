// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { NewBrowserPermissionCards } from './NewBrowserPermissionCards';
import { __resetBrowserConfigPersistenceForTests, useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import { createBrowserPermissionConfig } from '@/core/permissions/browserPermissionConfig';
import { getI18n, initLanguage } from '@/i18n';

const realSetDefault = useSettingsStore.getState().setBrowserPermissionDefault;
const realRetry = useSettingsStore.getState().retryBrowserConfigSave;
const setDefault = vi.fn<typeof realSetDefault>(async () => true);
const retry = vi.fn<typeof realRetry>();
const onManageSites = vi.fn();
const t = () => getI18n().settings;

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  localStorage.clear();
  vi.clearAllMocks();
  __resetBrowserConfigPersistenceForTests();
  useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
  useSettingsStore.setState({
    browserPermissionConfigV2: createBrowserPermissionConfig(),
    setBrowserPermissionDefault: setDefault,
    retryBrowserConfigSave: retry,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSettingsStore.setState({ setBrowserPermissionDefault: realSetDefault, retryBrowserConfigSave: realRetry });
});

function cards() {
  return render(<NewBrowserPermissionCards backend="builtin" onManageSites={onManageSites} />, { wrapper: DesignSystemProvider });
}
function setDefaults(defaults: Partial<ReturnType<typeof createBrowserPermissionConfig>['defaults']>) {
  const config = createBrowserPermissionConfig();
  useSettingsStore.setState({ browserPermissionConfigV2: { ...config, defaults: { ...config.defaults, ...defaults } } });
}
// The one place that knows how a level is picked.
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}
const RESOURCES = () => [t().browserBrowseLabel, t().browserOpClassUpload, t().browserOpClassScripting];
const LEVEL_NOTES = () => [t().browserDefaultAllowDesc, t().browserOpStateAskDesc, t().browserOpStateDenyDesc];

describe('default browser permissions', () => {
  it('starts from the shipped defaults', () => {
    expect(createBrowserPermissionConfig().defaults).toEqual({ browse: 'allow', upload: 'ask', script: 'ask' });
  });

  it.each([
    ['browse', () => t().browserBrowseLabel, () => t().browserOpStateDeny, 'deny'],
    ['upload', () => t().browserOpClassUpload, () => t().browserOpStateAllow, 'allow'],
    ['script', () => t().browserOpClassScripting, () => t().browserOpStateDeny, 'deny'],
  ] as const)('saves a new level for %s and touches no other resource', async (resource, label, option, value) => {
    cards();
    await choose(label(), option());
    expect(setDefault).toHaveBeenCalledOnce();
    expect(setDefault).toHaveBeenCalledWith(resource, value);
  });

  it('names each level select by its resource, lines the three up, and keeps the explanations in the list', async () => {
    const user = userEvent.setup();
    cards();
    const selects = screen.getAllByRole('combobox');
    expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual(RESOURCES());
    expect(selects.map((select) => select.textContent)).toEqual([t().browserOpStateAllow, t().browserOpStateAsk, t().browserOpStateAsk]);
    for (const select of selects) expect(select.parentElement).toHaveClass('w-52');
    for (const note of LEVEL_NOTES()) expect(screen.queryByText(note)).not.toBeInTheDocument();
    await user.click(selects[1]);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    for (const note of LEVEL_NOTES()) expect(screen.getByText(note)).toBeVisible();
    expect(screen.getByRole('option', { name: t().browserOpStateAsk })).toHaveAttribute('aria-selected', 'true');
    expect(setDefault).not.toHaveBeenCalled();
  });

  it('opens and moves the highlight on arrow keys without saving, and saves the highlighted level on Enter', async () => {
    const user = userEvent.setup();
    cards();
    screen.getByRole('combobox', { name: t().browserOpClassScripting }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}');
    expect(setDefault).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(setDefault).toHaveBeenCalledOnce();
    expect(setDefault).toHaveBeenCalledWith('script', 'deny');
  });

  it('saves nothing when the list is browsed and closed with Escape', async () => {
    const user = userEvent.setup();
    cards();
    screen.getByRole('combobox', { name: t().browserBrowseLabel }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Escape}');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(setDefault).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en-US'] as const)('saves nothing when characters are typed on a closed select (%s)', async (locale) => {
    initLanguage(locale);
    const user = userEvent.setup();
    cards();
    screen.getByRole('combobox', { name: t().browserOpClassUpload }).focus();
    await user.keyboard('adb禁允5');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(setDefault).not.toHaveBeenCalled();
  });

  it('puts the script risk in a warning message, and a failed save in an alert', () => {
    setDefaults({ script: 'allow' });
    cards();
    expect(screen.getByRole('status')).toHaveTextContent(t().browserUnattendedScriptRiskWarning);
    act(() => useBrowserSaveStatusStore.getState().settleBrowserSave('browserPermissionConfigV2', 'failed'));
    expect(screen.getByRole('alert')).toHaveTextContent(t().browserSaveFailed);
  });

  it('warns about scripts only while they are allowed', () => {
    setDefaults({ script: 'allow' });
    const { unmount } = cards();
    expect(screen.getByText(t().browserUnattendedScriptRiskWarning)).toBeInTheDocument();
    unmount();
    for (const script of ['ask', 'deny'] as const) {
      setDefaults({ script, browse: 'allow', upload: 'allow' });
      const view = cards();
      expect(screen.queryByText(t().browserUnattendedScriptRiskWarning)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows only the alert when the saved configuration cannot be read', () => {
    useSettingsStore.setState({ browserPermissionConfigV2: { schemaVersion: 1 } as never });
    cards();
    expect(screen.getByRole('alert')).toHaveTextContent(t().browserConfigInvalid);
    expect(screen.queryByText(t().browserBrowseLabel)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a retry after a failed save and retries the permission configuration', () => {
    cards();
    act(() => useBrowserSaveStatusStore.getState().settleBrowserSave('browserPermissionConfigV2', 'failed'));
    expect(screen.getByText(t().browserSaveFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t().browserSaveRetry }));
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('browserPermissionConfigV2');
  });

  it('says a save is in flight without a retry', () => {
    cards();
    act(() => useBrowserSaveStatusStore.getState().beginBrowserSave('browserPermissionConfigV2'));
    expect(screen.getByRole('status')).toHaveTextContent(t().browserSaveSaving);
    expect(screen.queryByRole('button', { name: t().browserSaveRetry })).not.toBeInTheDocument();
  });

  it('stops mentioning a successful save after 2.5 seconds', () => {
    vi.useFakeTimers();
    cards();
    act(() => useBrowserSaveStatusStore.getState().settleBrowserSave('browserPermissionConfigV2', 'saved'));
    expect(screen.getByRole('status')).toHaveTextContent(t().browserSaveSaved);
    act(() => { vi.advanceTimersByTime(2499); });
    expect(screen.getByRole('status')).toHaveTextContent(t().browserSaveSaved);
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(useBrowserSaveStatusStore.getState().status.browserPermissionConfigV2).toBeUndefined();
  });

  it('opens the site settings from its entry and counts every site with its own rule', () => {
    const config = createBrowserPermissionConfig();
    config.sites['https://docs.example'] = { blocked: true, browse: 'inherit', upload: 'inherit', script: 'inherit' };
    config.embeddedSites['https://host.example'] = { 'https://frame.example': { browse: 'allow', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    cards();
    const entry = screen.getByRole('button', { name: t().browserSitePermsTitle });
    expect(entry).toHaveTextContent('已为 2 个网站单独设置权限');
    fireEvent.click(entry);
    expect(onManageSites).toHaveBeenCalledOnce();
  });
});
