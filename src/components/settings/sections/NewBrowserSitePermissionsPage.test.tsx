// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { NewBrowserSitePermissionsPage } from './NewBrowserPermissionCards';
import { __resetBrowserConfigPersistenceForTests, useSettingsStore } from '@/stores/settingsStore';
import { useBrowserSaveStatusStore } from '@/stores/browserSaveStatus';
import { createBrowserPermissionConfig, emptyBrowserSiteRule, type BrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { format, getI18n, initLanguage } from '@/i18n';
import { passSettleInterval } from '@/test/dsWindows';

// The real select, with its renders counted by label: a website row must stay still while
// the page around it re-renders.
const selectRenders = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock('@/components/ds/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/select')>();
  return {
    ...actual,
    Select: (props: Parameters<typeof actual.Select>[0]) => {
      selectRenders.labels.push(props.label);
      return <actual.Select {...props} />;
    },
  };
});

const origin = 'https://docs.example';
const browsing: BrowserSiteRule = { ...emptyBrowserSiteRule(), browse: 'allow' };
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
  // A spy on a store action is copied into every later state object, so its calls outlive the test that made it.
  vi.clearAllMocks();
  __resetBrowserConfigPersistenceForTests();
  useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
  useSettingsStore.setState({ browserPermissionConfigV2: createBrowserPermissionConfig() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function page(rule?: BrowserSiteRule) {
  if (rule) useSettingsStore.setState({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [origin]: rule } } });
  render(<StrictMode><DesignSystemProvider><NewBrowserSitePermissionsPage trail={['网站权限']} onNavigate={vi.fn()} /></DesignSystemProvider></StrictMode>);
}

// How the page's controls are found and operated. Everything below goes through these.
function statusSelect(index = 0) {
  return screen.getAllByRole('combobox', { name: `${origin} ${t().browserSiteAccess}` })[index];
}
function statusValue(index = 0) {
  return statusSelect(index).textContent;
}
async function chooseStatus(option: string, index = 0) {
  const user = userEvent.setup();
  await user.click(statusSelect(index));
  await user.click(screen.getByRole('option', { name: option }));
}
// The window opens once the list has closed and given the focus back to its select.
async function openCustom(index = 0) {
  await chooseStatus(t().browserSiteCustom, index);
  return screen.findByRole('dialog', { name: t().browserSiteCustomTitle });
}
function ruleSelect(dialog: HTMLElement, label: string) {
  return within(dialog).getByRole('combobox', { name: label });
}
function ruleValue(dialog: HTMLElement, label: string) {
  return ruleSelect(dialog, label).textContent;
}
async function chooseRule(dialog: HTMLElement, label: string, option: string) {
  const user = userEvent.setup();
  await user.click(ruleSelect(dialog, label));
  await user.click(screen.getByRole('option', { name: option }));
}
async function openAdd(address?: string) {
  fireEvent.click(screen.getByRole('button', { name: t().browserSitePermsAddButton }));
  const dialog = screen.getByRole('dialog', { name: t().browserSiteAddTitle });
  if (address !== undefined) fireEvent.change(within(dialog).getByLabelText(t().browserSitePermsAddLabel), { target: { value: address } });
  return dialog;
}
function addButton(dialog: HTMLElement) {
  return within(dialog).getByRole('button', { name: t().browserSitePermsAddButton });
}
function removeButton() {
  return screen.getByRole('button', { name: format(t().browserSiteDeleteLabel, { origin }) });
}
async function askToRemove() {
  fireEvent.click(removeButton());
  return screen.getByRole('alertdialog', { name: t().browserSiteDeleteTitle });
}
function removalDialog() {
  return screen.queryByRole('alertdialog');
}
function discardQuestion() {
  return screen.queryByRole('alertdialog', { name: getI18n().designSystem.discardTitle });
}

describe('compact website exceptions', () => {
  it('keeps an empty page uncluttered and adds one exact origin with browsing allowed', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /筛选网站授权/ })).toBeNull();
    const dialog = await openAdd(`${origin}/guide`);
    expect(within(dialog).getByText(`${t().browserSitePermsEffectiveOrigin}: ${origin}`)).toBeInTheDocument();
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(save).toHaveBeenCalledWith(origin, browsing, null, expect.any(Function));
    expect(save).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('edits in a modal, shows actual defaults, and cancels without writing', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page(browsing);
    expect(screen.queryByRole('textbox', { name: /搜索网站授权/ })).toBeNull();
    const dialog = await openCustom();
    expect(ruleValue(dialog, '上传文件')).toBe('默认（每次询问）');
    await chooseRule(dialog, '上传文件', t().browserOpStateAllow);
    expect(ruleValue(dialog, '上传文件')).toBe(t().browserOpStateAllow);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each([false, true])('shows the effective inherited state for an embedded rule (blocked=%s)', async (blocked) => {
    const config = createBrowserPermissionConfig();
    config.sites[origin] = { ...browsing, blocked, upload: 'deny' };
    config.embeddedSites['https://host.example'] = { [origin]: { browse: 'inherit', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    // The embedded row already reads Custom: picking Custom again is how its rule is edited.
    expect(statusValue(1)).toBe(t().browserSiteCustom);
    const dialog = await openCustom(1);
    expect(ruleValue(dialog, '上传文件')).toBe('默认（禁止）');
    expect(ruleValue(dialog, '浏览网页')).toBe(blocked ? '默认（禁止）' : '默认（允许）');
  });
  it('saves a complete custom rule once and makes unblocking explicit', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const blocked = { ...browsing, blocked: true };
    page(blocked);
    const dialog = await openCustom();
    expect(within(dialog).getByText(t().browserSiteUnblockOnSave)).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSitePermsSave })); });
    expect(save).toHaveBeenCalledWith(origin, browsing, blocked, expect.any(Function));
    expect(save).toHaveBeenCalledOnce();
  });
  it.each(['浏览网页', '上传文件', '运行脚本'])('closes only the open list of "%s" on Escape, and the window on the next Escape', async (label) => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const user = userEvent.setup();
    page(browsing);
    const dialog = await openCustom();
    const select = ruleSelect(dialog, label);
    expect(select.parentElement).toHaveClass('w-52');
    await user.click(select);
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: t().browserSiteCustomTitle })).toBe(dialog);
    await waitFor(() => expect(select).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('invalidates a pending save when cancelled and confirms removal separately', async () => {
    let finish!: (result: 'saved') => void;
    const saving = new Promise<'saved'>((resolve) => { finish = resolve; });
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving);
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    page(browsing);
    const dialog = await openCustom();
    fireEvent.click(within(dialog).getByRole('button', { name: t().browserSitePermsSave }));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(save.mock.calls[0][3]?.()).toBe(false);
    await act(async () => { finish('saved'); await saving; });
    await askToRemove();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/重新跟随默认权限/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除例外' })); });
    expect(remove).toHaveBeenCalledWith(origin, browsing, expect.any(Function));
  });
});

describe('adding a website', () => {
  it('cannot add while the address is empty', async () => {
    page();
    const dialog = await openAdd();
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(t().browserSitePermsAddLabel), { target: { value: '   ' } });
    expect(addButton(dialog)).toBeDisabled();
  });
  it('refuses an address that carries a user name or password', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page();
    const dialog = await openAdd('https://user:pass@example.com');
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSitePermsAddCredentials);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
  it('refuses an address that is not a full web address', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page();
    const dialog = await openAdd('not a site');
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSitePermsAddInvalid);
    expect(save).not.toHaveBeenCalled();
  });
  it('refuses a website that already has its own rule', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page(browsing);
    const dialog = await openAdd(`${origin}/again?q=1`);
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSiteAlreadyAdded);
    expect(save).not.toHaveBeenCalled();
  });
  it('clears the error as soon as the address changes', async () => {
    page();
    const dialog = await openAdd('not a site');
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(t().browserSitePermsAddLabel), { target: { value: 'https://ok.example' } });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('changing a website', () => {
  it('blocks a website with the rule it had as the expected one', async () => {
    let finish!: (result: 'saved') => void;
    const saving = new Promise<'saved'>((resolve) => { finish = resolve; });
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving);
    const rule: BrowserSiteRule = { ...browsing, upload: 'deny' };
    page(rule);
    await chooseStatus(t().browserSiteAccessBlock);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(origin, { ...rule, blocked: true }, rule, expect.any(Function));
    // The write may go ahead while nothing else was started, and every control waits for it.
    expect(save.mock.calls[0][3]?.()).toBe(true);
    expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toBeDisabled();
    expect(screen.getByRole('button', { name: format(t().browserSiteDeleteLabel, { origin }) })).toBeDisabled();
    await act(async () => { finish('saved'); await saving; });
    expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toBeEnabled();
  });
  it('allows browsing again from a blocked website', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const blocked: BrowserSiteRule = { ...browsing, blocked: true };
    page(blocked);
    await chooseStatus(t().browserSiteAllowBrowse);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(origin, browsing, blocked, expect.any(Function));
  });
  it('says so on the page when another window changed the website first, and changes nothing', async () => {
    vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('conflict');
    page(browsing);
    await chooseStatus(t().browserSiteAccessBlock);
    expect(screen.getByRole('alert')).toHaveTextContent(t().browserSiteRuleConflict);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(statusValue()).toBe(t().browserSiteAllowBrowse);
    expect(screen.getByRole('region', { name: origin })).toBeInTheDocument();
  });
  it('keeps the custom rule window open with the reason when the save conflicts or fails', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('conflict');
    page(browsing);
    const dialog = await openCustom();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSitePermsSave })); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSiteRuleConflict);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    save.mockResolvedValue('failed');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSitePermsSave })); });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSaveFailed);
  });
  it('saves an embedded rule through the embedded writer, without the blocked flag', async () => {
    const config = createBrowserPermissionConfig();
    config.embeddedSites['https://host.example'] = { [origin]: { browse: 'ask', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    const saveEmbedded = vi.spyOn(useSettingsStore.getState(), 'setBrowserEmbeddedRule').mockResolvedValue('saved');
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    page();
    expect(screen.getByText(format(t().browserEmbeddedScope, { origin: 'https://host.example' }))).toBeInTheDocument();
    await chooseStatus(t().browserSiteAllowBrowse);
    expect(saveEmbedded).toHaveBeenCalledOnce();
    expect(saveEmbedded).toHaveBeenCalledWith(
      'https://host.example', origin,
      { browse: 'allow', upload: 'inherit', script: 'inherit' },
      { browse: 'ask', upload: 'inherit', script: 'inherit' },
      expect.any(Function),
    );
    expect(save).not.toHaveBeenCalled();
  });
});

describe('removing a website', () => {
  it('asks first, names the website, and removes the rule it showed when the bin was clicked', async () => {
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    const shown: BrowserSiteRule = { ...browsing, upload: 'deny' };
    page(shown);
    const dialog = await askToRemove();
    expect(dialog).toHaveTextContent(t().browserSiteDeleteTitle);
    expect(dialog).toHaveTextContent(format(t().browserSiteDeleteMessage, { origin }));
    expect(remove).not.toHaveBeenCalled();
    // Another window changes the rule while the question is open: the question still carries
    // the rule the user saw, and the store refuses when it no longer matches.
    act(() => useSettingsStore.setState({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [origin]: { ...shown, script: 'allow' } } } }));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSiteDeleteButton })); });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(origin, shown, expect.any(Function));
    expect(removalDialog()).toBeNull();
  });
  it('keeps the website when the user cancels', async () => {
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    page(browsing);
    const dialog = await askToRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(remove).not.toHaveBeenCalled();
    expect(removalDialog()).toBeNull();
    expect(screen.getByRole('region', { name: origin })).toBeInTheDocument();
  });
  it('stays open and says why when the removal fails', async () => {
    vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(false);
    page(browsing);
    const dialog = await askToRemove();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSiteDeleteButton })); });
    expect(removalDialog()).toBe(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t().browserSaveFailed);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
  it('ignores an answer that arrives after the question was closed', async () => {
    let finish!: (removed: boolean) => void;
    const removing = new Promise<boolean>((resolve) => { finish = resolve; });
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockReturnValue(removing);
    page(browsing);
    const dialog = await askToRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: t().browserSiteDeleteButton }));
    expect(within(dialog).getByRole('button', { name: t().browserSiteDeleteButton })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(remove.mock.calls[0][2]?.()).toBe(false);
    await act(async () => { finish(false); await removing; });
    expect(removalDialog()).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toBeEnabled();
  });
  it('removes an embedded rule through the embedded writer', async () => {
    const config = createBrowserPermissionConfig();
    config.embeddedSites['https://host.example'] = { [origin]: { browse: 'ask', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    const saveEmbedded = vi.spyOn(useSettingsStore.getState(), 'setBrowserEmbeddedRule').mockResolvedValue('saved');
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    page();
    const dialog = await askToRemove();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: t().browserSiteDeleteButton })); });
    expect(saveEmbedded).toHaveBeenCalledWith('https://host.example', origin, null, { browse: 'ask', upload: 'inherit', script: 'inherit' }, expect.any(Function));
    expect(remove).not.toHaveBeenCalled();
  });
});

// The button that started a save or a removal keeps the focus while it runs: it is marked
// busy, takes no second press, and is not switched off under the keyboard.
describe('a button whose own action is running', () => {
  function pending<T>() {
    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => { finish = resolve; });
    return { promise, finish };
  }
  function expectBusyWithFocus(button: HTMLElement) {
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
  }

  it('keeps the focus on 添加 while the website is saved, and saves once', async () => {
    const saving = pending<'saved'>();
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving.promise);
    page();
    const dialog = await openAdd(origin);
    const add = addButton(dialog);
    add.focus();

    fireEvent.click(add);
    expectBusyWithFocus(add);
    fireEvent.click(add);
    expect(save).toHaveBeenCalledOnce();

    await act(async () => { saving.finish('saved'); await saving.promise; });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the focus on 保存 while a custom rule is saved, and saves once', async () => {
    const saving = pending<'saved'>();
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving.promise);
    page(browsing);
    const dialog = await openCustom();
    const saveButton = within(dialog).getByRole('button', { name: t().browserSitePermsSave });
    saveButton.focus();

    fireEvent.click(saveButton);
    expectBusyWithFocus(saveButton);
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledOnce();

    await act(async () => { saving.finish('saved'); await saving.promise; });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the focus on 删除例外 while the website is removed, and removes once', async () => {
    const removing = pending<boolean>();
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockReturnValue(removing.promise);
    page(browsing);
    const dialog = await askToRemove();
    const removeNow = within(dialog).getByRole('button', { name: t().browserSiteDeleteButton });
    removeNow.focus();

    fireEvent.click(removeNow);
    expectBusyWithFocus(removeNow);
    fireEvent.click(removeNow);
    expect(remove).toHaveBeenCalledOnce();

    await act(async () => { removing.finish(false); await removing.promise; });
    // A failed removal leaves the question open, and the button takes a press again.
    expect(removeNow).not.toHaveAttribute('aria-disabled');
    expect(removeNow).toHaveFocus();
  });

  it('still switches 添加 off while the address is empty', async () => {
    page();
    const dialog = await openAdd('');
    expect(addButton(dialog)).toBeDisabled();
    expect(addButton(dialog)).not.toHaveAttribute('aria-disabled');
  });
});

// The delete button under the keyboard goes away with its website. The focus goes to the
// website that takes its place, so the next Tab continues from there.
describe('keyboard focus after a removal', () => {
  const sites = ['https://a.example', 'https://b.example', 'https://c.example'];
  function pageWith(origins: string[]) {
    const config = createBrowserPermissionConfig();
    for (const site of origins) config.sites[site] = browsing;
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    // The store's own removal writes to disk; this one takes the website out of the saved rules.
    vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockImplementation(async (site) => {
      const current = useSettingsStore.getState().browserPermissionConfigV2 as ReturnType<typeof createBrowserPermissionConfig>;
      const remaining = { ...current.sites };
      delete remaining[site];
      useSettingsStore.setState({ browserPermissionConfigV2: { ...current, sites: remaining } });
      return true;
    });
    page();
  }
  const deleteButton = (site: string) => screen.getByRole('button', { name: format(t().browserSiteDeleteLabel, { origin: site }) });
  const access = (site: string) => screen.getByRole('combobox', { name: `${site} ${t().browserSiteAccess}` });
  async function answerByKeyboard(site: string, answer: string) {
    // No pause between the focus and the key: a focus move left over from the test before (Radix
    // gives focus back from a timer) cannot land in between.
    const user = userEvent.setup({ delay: null });
    deleteButton(site).focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('alertdialog', { name: t().browserSiteDeleteTitle });
    within(dialog).getByRole('button', { name: answer }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(removalDialog()).toBeNull());
  }

  it('goes to the first control of the next website', async () => {
    pageWith(sites);
    await answerByKeyboard(sites[1], t().browserSiteDeleteButton);
    expect(screen.queryByRole('region', { name: sites[1] })).toBeNull();
    await waitFor(() => expect(access(sites[2])).toHaveFocus());
  });
  it('goes to the previous website when the last one was removed', async () => {
    pageWith(sites);
    await answerByKeyboard(sites[2], t().browserSiteDeleteButton);
    await waitFor(() => expect(access(sites[1])).toHaveFocus());
  });
  it('goes to the add button when no website is left', async () => {
    pageWith([sites[0]]);
    await answerByKeyboard(sites[0], t().browserSiteDeleteButton);
    expect(screen.getByText(t().browserSitePermsEmpty)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toHaveFocus());
  });
  it('goes back to the delete button when the website is kept', async () => {
    pageWith(sites);
    await answerByKeyboard(sites[1], '取消');
    await waitFor(() => expect(deleteButton(sites[1])).toHaveFocus());
  });
});

describe('the list', () => {
  it('says the list is empty, and shows one region per website in address order once there are some', () => {
    page();
    expect(screen.getByText(t().browserSitePermsEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    cleanup();
    const config = createBrowserPermissionConfig();
    config.sites['https://b.example'] = browsing;
    config.sites['https://a.example'] = { ...browsing, blocked: true };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['https://a.example', 'https://b.example']);
    expect(screen.getByRole('heading', { level: 4, name: 'https://a.example' })).toHaveAttribute('title', 'https://a.example');
    expect(screen.getByText(t().browserSiteRulesFootnote)).toBeInTheDocument();
  });
  it('shows only the alert when the saved configuration cannot be read', () => {
    useSettingsStore.setState({ browserPermissionConfigV2: { schemaVersion: 1 } as never });
    page();
    expect(screen.getByRole('alert')).toHaveTextContent(t().browserConfigInvalid);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the access select of a website', () => {
  it('is named after the website, as wide as its neighbours, and marks each choice with a status shape', async () => {
    const user = userEvent.setup();
    const config = createBrowserPermissionConfig();
    config.sites[origin] = browsing;
    config.sites['https://other.example'] = { ...browsing, blocked: true };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    const selects = screen.getAllByRole('combobox');
    expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([`${origin} ${t().browserSiteAccess}`, `https://other.example ${t().browserSiteAccess}`]);
    expect(selects.map((select) => select.textContent)).toEqual([t().browserSiteAllowBrowse, t().browserSiteAccessBlock]);
    for (const select of selects) expect(select.parentElement).toHaveClass('w-48');
    expect(selects[0].querySelector('svg')).toHaveClass('text-success');
    expect(selects[1].querySelector('svg')).toHaveClass('text-danger');
    await user.click(selects[0]);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([t().browserSiteAllowBrowse, t().browserSiteAccessBlock, t().browserSiteCustom]);
    expect(options[0].querySelector('svg')).toHaveClass('text-success');
    expect(options[1].querySelector('svg')).toHaveClass('text-danger');
    expect(options[2].querySelector('svg')).toHaveClass('text-label-secondary');
  });
  it('cannot block a website that only has a rule inside another website', async () => {
    const user = userEvent.setup();
    const config = createBrowserPermissionConfig();
    config.embeddedSites['https://host.example'] = { [origin]: { browse: 'allow', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    await user.click(statusSelect());
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([t().browserSiteAllowBrowse, t().browserSiteCustom]);
  });
  it('saves nothing from arrow keys or typing; Enter saves the highlighted choice', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const user = userEvent.setup();
    page(browsing);
    statusSelect().focus();
    await user.keyboard('禁b');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}');
    expect(save).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(save).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toBeEnabled());
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(origin, { ...browsing, blocked: true }, browsing, expect.any(Function));
  });
  it('opens the custom rule window with the focus inside it, and gives the focus back to the select afterwards', async () => {
    page(browsing);
    const select = statusSelect();
    const dialog = await openCustom();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(select).toHaveFocus());
  });
  it('does not open the custom rule window when the list is reopened before the window appears', async () => {
    const user = userEvent.setup();
    page(browsing);
    await user.click(statusSelect());
    // The choice is recorded; reopening the list in the same instant drops it before it runs.
    fireEvent.keyDown(screen.getByRole('option', { name: t().browserSiteCustom }), { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.pointerDown(statusSelect(), { button: 0, pointerType: 'mouse' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(statusSelect()).toHaveFocus());
    expect(screen.queryByRole('dialog')).toBeNull();
    // Picked again and left alone, it opens the window.
    await openCustom();
  });
});

describe('website rows while the page re-renders', () => {
  function threeSites() {
    const config = createBrowserPermissionConfig();
    for (const site of ['https://a.example', 'https://b.example', 'https://c.example']) config.sites[site] = browsing;
    config.embeddedSites['https://host.example'] = { 'https://frame.example': { browse: 'ask', upload: 'inherit', script: 'inherit' } };
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    return config;
  }
  it('renders no row again while an address is typed in the add window', async () => {
    threeSites();
    page();
    const dialog = await openAdd();
    selectRenders.labels = [];
    const field = within(dialog).getByLabelText(t().browserSitePermsAddLabel);
    for (const address of ['h', 'ht', 'https://new.example']) fireEvent.change(field, { target: { value: address } });
    expect(within(dialog).getByText(`${t().browserSitePermsEffectiveOrigin}: https://new.example`)).toBeInTheDocument();
    expect(selectRenders.labels).toEqual([]);
  });
  it('renders only the row whose rule changed', () => {
    const config = threeSites();
    page();
    selectRenders.labels = [];
    act(() => useSettingsStore.setState({ browserPermissionConfigV2: { ...config, sites: { ...config.sites, 'https://b.example': { ...browsing, blocked: true } } } }));
    expect(new Set(selectRenders.labels)).toEqual(new Set([`https://b.example ${t().browserSiteAccess}`]));
    expect(screen.getAllByRole('combobox').map((select) => select.textContent)).toEqual([
      t().browserSiteAllowBrowse, t().browserSiteAccessBlock, t().browserSiteAllowBrowse, t().browserSiteCustom,
    ]);
  });
});

describe('windows opened from the page', () => {
  it('closes an empty add window on Escape', async () => {
    const user = userEvent.setup();
    page();
    await user.click(screen.getByRole('button', { name: t().browserSitePermsAddButton }));
    const dialog = screen.getByRole('dialog', { name: t().browserSiteAddTitle });
    expect(within(dialog).getByLabelText(t().browserSitePermsAddLabel)).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(discardQuestion()).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toHaveFocus());
  });
  it('asks before Escape discards a typed address, and keeps the address when the user goes on', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const user = userEvent.setup();
    page();
    await openAdd(`${origin}/guide`);
    await user.keyboard('{Escape}');
    const question = discardQuestion()!;
    expect(question).toHaveTextContent(getI18n().designSystem.discardMessage);
    // The question takes no pointer press for a moment after it appears: it has been read.
    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: getI18n().designSystem.keepEditing }));
    expect(discardQuestion()).toBeNull();
    const dialog = screen.getByRole('dialog', { name: t().browserSiteAddTitle });
    expect(within(dialog).getByLabelText(t().browserSitePermsAddLabel)).toHaveValue(`${origin}/guide`);
    await user.keyboard('{Escape}');
    passSettleInterval();
    await user.click(within(discardQuestion()!).getByRole('button', { name: getI18n().designSystem.discard }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    // The next add window starts empty.
    const again = await openAdd();
    expect(within(again).getByLabelText(t().browserSitePermsAddLabel)).toHaveValue('');
  });
  it('asks the same question when Cancel is pressed on a typed address', async () => {
    const user = userEvent.setup();
    page();
    const dialog = await openAdd(`${origin}/guide`);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(discardQuestion()).not.toBeNull();
    // The add window waits behind the question with what was typed.
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector('input')).toHaveValue(`${origin}/guide`);
  });
  it('closes an empty add window from Cancel without asking', async () => {
    const user = userEvent.setup();
    page();
    const dialog = await openAdd();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(discardQuestion()).toBeNull();
  });
  it('asks about removal in an alert window that starts on Cancel and closes alone on Escape', async () => {
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    const user = userEvent.setup();
    page(browsing);
    await user.click(removeButton());
    const dialog = screen.getByRole('alertdialog', { name: t().browserSiteDeleteTitle });
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(removalDialog()).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(removeButton()).toHaveFocus());
  });
  it('takes the removal question away with the settings window, without removing anything', async () => {
    const remove = vi.spyOn(useSettingsStore.getState(), 'removeBrowserSiteRule').mockResolvedValue(true);
    useSettingsStore.setState({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [origin]: browsing } } });
    let closeSettings!: () => void;
    function Settings() {
      const [open, setOpen] = useState(true);
      closeSettings = () => setOpen(false);
      return <Dialog open={open} onOpenChange={setOpen} title="Settings" size="page"><NewBrowserSitePermissionsPage trail={['网站权限']} onNavigate={vi.fn()} /></Dialog>;
    }
    const user = userEvent.setup();
    render(<Settings />, { wrapper: DesignSystemProvider });
    await askToRemove();
    await user.keyboard('{Escape}');
    expect(removalDialog()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await askToRemove();
    act(() => closeSettings());
    expect(removalDialog()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it('asks before a press outside discards a typed address, and closes only the add window', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    // The page behind an open window ignores the pointer; the press still lands on the dimmed area.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onSettingsChange = vi.fn();
    render(
      <Dialog open onOpenChange={onSettingsChange} title="Settings" size="page"><NewBrowserSitePermissionsPage trail={['网站权限']} onNavigate={vi.fn()} /></Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const pressOutside = async () => {
      const dimmed = document.querySelectorAll('.bg-scrim');
      await user.click(dimmed[dimmed.length - 1]);
    };
    const addWindow = () => screen.queryByRole('dialog', { name: t().browserSiteAddTitle });
    await openAdd(`${origin}/guide`);
    await pressOutside();
    passSettleInterval();
    await user.click(within(discardQuestion()!).getByRole('button', { name: getI18n().designSystem.keepEditing }));
    expect(within(addWindow()!).getByLabelText(t().browserSitePermsAddLabel)).toHaveValue(`${origin}/guide`);
    await pressOutside();
    passSettleInterval();
    await user.click(within(discardQuestion()!).getByRole('button', { name: getI18n().designSystem.discard }));
    expect(addWindow()).toBeNull();
    expect(discardQuestion()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    // An empty add window closes from the same press, and the settings window stays.
    await openAdd();
    await pressOutside();
    expect(addWindow()).toBeNull();
    expect(discardQuestion()).toBeNull();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });
  it('takes the discard question away when the save that was in flight closes the add window', async () => {
    let finish!: (result: 'saved') => void;
    const saving = new Promise<'saved'>((resolve) => { finish = resolve; });
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockReturnValue(saving);
    const user = userEvent.setup();
    page();
    const dialog = await openAdd(`${origin}/guide`);
    fireEvent.click(addButton(dialog));
    await user.keyboard('{Escape}');
    expect(discardQuestion()).not.toBeNull();
    await act(async () => { finish('saved'); await saving; });
    expect(discardQuestion()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: t().browserSitePermsAddButton })).toBeEnabled();
  });
  it('writes the website once when Add is pressed again while the add window fades out', async () => {
    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
    // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    // Saves the way the store does: the website is in the configuration once the save has answered.
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockImplementation(async (site, rule) => {
      useSettingsStore.setState({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [site]: rule } } });
      return 'saved';
    });
    page();
    const dialog = await openAdd(`${origin}/guide`);
    await act(async () => { fireEvent.click(addButton(dialog)); });
    expect(save).toHaveBeenCalledOnce();
    const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]')!;
    expect(closing).toBeInTheDocument();

    // The window is still on the page and its button still takes the click: the window is closing,
    // so nothing is written again and nothing is said about a website that is already listed.
    await act(async () => { fireEvent.click(addButton(closing)); });

    expect(save).toHaveBeenCalledOnce();
    expect(screen.queryByText(t().browserSiteAlreadyAdded)).toBeNull();
  });
});

describe('the list changing under an open access list', () => {
  it('keeps the list open and writes to its own website with the rule that is saved now', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteRule').mockResolvedValue('saved');
    const user = userEvent.setup();
    const config = createBrowserPermissionConfig();
    config.sites['https://a.example'] = browsing;
    config.sites['https://b.example'] = browsing;
    useSettingsStore.setState({ browserPermissionConfigV2: config });
    page();
    await user.click(screen.getByRole('combobox', { name: `https://b.example ${t().browserSiteAccess}` }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // Another window adds a website that sorts in front, and changes the rule of the open row.
    const changed: BrowserSiteRule = { ...browsing, upload: 'deny' };
    act(() => useSettingsStore.setState({ browserPermissionConfigV2: { ...config, sites: { 'https://a.example': browsing, 'https://a0.example': browsing, 'https://b.example': changed } } }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: t().browserSiteAccessBlock }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('https://b.example', { ...changed, blocked: true }, changed, expect.any(Function));
  });
});
