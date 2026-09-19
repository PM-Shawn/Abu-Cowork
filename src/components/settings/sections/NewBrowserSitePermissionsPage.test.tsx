// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewBrowserSitePermissionsPage } from './NewBrowserPermissionCards';
import { __resetBrowserConfigPersistenceForTests, useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import { createBrowserPermissionConfig, emptyBrowserSiteRule, type BrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { getI18n, initLanguage } from '@/i18n';

const origin = 'https://docs.example';
const browsing: BrowserSiteRule = { ...emptyBrowserSiteRule(), browse: 'allow' };
beforeEach(() => {
  initLanguage('zh-CN');
  localStorage.clear();
  __resetBrowserConfigPersistenceForTests();
  useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
  useSettingsStore.setState({ browserPermissionConfigV2: createBrowserPermissionConfig() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function page(rule?: BrowserSiteRule) {
  if (rule) useSettingsStore.setState({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [origin]: rule } } });
  render(<StrictMode><NewBrowserSitePermissionsPage trail={['网站权限']} onNavigate={vi.fn()} /></StrictMode>);
}
function openCustom() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${origin} 网站访问`) }));
  fireEvent.click(screen.getByRole('button', { name: getI18n().settings.browserSiteCustom }));
  return screen.getByRole('dialog');
}
describe('compact website exceptions', () => {
  it('keeps an empty page uncluttered and adds one exact origin with browsing allowed', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /筛选网站授权/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('网站地址'), { target: { value: `${origin}/guide` } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '添加' })); });
    expect(save).toHaveBeenCalledWith(origin, browsing, null, expect.any(Function));
    expect(save).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('edits in a modal, shows actual defaults, and cancels without writing', () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page(browsing);
    expect(screen.queryByRole('textbox', { name: /搜索网站授权/ })).toBeNull();
    const dialog = openCustom();
    const upload = within(dialog).getByRole('button', { name: /^上传文件: 默认（每次询问）$/ });
    fireEvent.click(upload);
    fireEvent.click(screen.getByRole('button', { name: `${getI18n().settings.browserOpStateAllow} ${getI18n().settings.browserDefaultAllowDesc}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each([false, true])('shows the effective inherited state for an embedded rule (blocked=%s)', (blocked) => {
    const config = createBrowserPermissionConfig();
    config.sites[origin] = { ...browsing, blocked, upload: 'deny' };
    config.embeddedSites['https://host.example'] = { [origin]: { browse: 'inherit', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`${origin} 网站访问`) })[1]);
    fireEvent.click(screen.getByRole('button', { name: getI18n().settings.browserSiteCustom }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '上传文件: 默认（禁止）' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: blocked ? '浏览网页: 默认（禁止）' : '浏览网页: 默认（允许）' })).toBeTruthy();
  });
  it('saves a complete custom rule once and makes unblocking explicit', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const blocked = { ...browsing, blocked: true };
    page(blocked);
    const dialog = openCustom();
    expect(within(dialog).getByText(getI18n().settings.browserSiteUnblockOnSave)).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: getI18n().settings.browserSitePermsSave })); });
    expect(save).toHaveBeenCalledWith(origin, browsing, blocked, expect.any(Function));
    expect(save).toHaveBeenCalledOnce();
  });
  it('closes only an expanded menu on Escape and advances from its trigger on Tab', () => {
    page(browsing);
    const dialog = openCustom();
    const browse = within(dialog).getByRole('button', { name: /^浏览网页:/ });
    const upload = within(dialog).getByRole('button', { name: /^上传文件:/ });
    fireEvent.click(browse);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(browse.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(browse);
    fireEvent.click(browse);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(upload);
    expect(browse.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('invalidates a pending save when cancelled and confirms removal separately', async () => {
    let finish!: (result: 'saved') => void;
    const saving = new Promise<'saved'>((resolve) => { finish = resolve; });
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving);
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    page(browsing);
    const dialog = openCustom();
    fireEvent.click(within(dialog).getByRole('button', { name: getI18n().settings.browserSitePermsSave }));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(save.mock.calls[0][3]?.()).toBe(false);
    await act(async () => { finish('saved'); await saving; });
    fireEvent.click(screen.getByRole('button', { name: `删除 ${origin} 的设置` }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/重新跟随默认权限/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除例外' })); });
    expect(remove).toHaveBeenCalledWith(origin, browsing, expect.any(Function));
  });
});
