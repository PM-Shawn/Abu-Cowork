// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandConfirmDialog, { type CommandConfirmRequest } from './CommandConfirmDialog';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextField } from '@/components/ds/text-field';
import { initLanguage } from '@/i18n';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests } from '@/stores/settingsStore';
import { createBrowserPermissionConfig, emptyBrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';

// Pins the browser-confirmation button set: which scopes are offered is a
// security decision made by the requester (allowPersistentGrant), and the
// "always allow this site" click must both persist the verdict and resolve
// the approval — a dialog that only did one of the two would either nag
// forever or grant without asking.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
function restoreNavigatorLocks() {
  if (originalLocksDescriptor) Object.defineProperty(navigator, 'locks', originalLocksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
}

describe('CommandConfirmDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    let writes = Promise.resolve<unknown>(undefined);
    const browserNavigator = navigator;
    Object.defineProperty(browserNavigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => {
      const job = writes.then(callback); writes = job.catch(() => undefined); return job;
    } } });
    vi.stubGlobal('navigator', browserNavigator);
    __resetBrowserConfigPersistenceForTests();
    localStorage.clear();
    setMigratedBrowserSettings({ browserPermissionConfigV2: createBrowserPermissionConfig() });
  });

  afterEach(() => {
    cleanup(); vi.unstubAllGlobals(); restoreNavigatorLocks();
  });

  function renderDialog(overrides: Partial<CommandConfirmRequest>) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CommandConfirmDialog
        request={{
          command: 'abu-browser__navigate (https://example.com)',
          level: 'warn',
          reason: 'reason',
          kind: 'browser',
          browserPermissionResource: overrides.kind === 'browser-upload' ? 'upload' : 'browse',
          browserPermissionTargets: overrides.browserOrigin ? [{ origin: overrides.browserOrigin, embeddedIn: overrides.browserPageOrigin }] : [],
          ...overrides,
        }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  it('offers a one-shot action and a resource-specific saved grant', () => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    expect(screen.getByRole('button', { name: '仅允许这次' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '以后允许在此网站浏览' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });
  it.each(['browse', 'upload'] as const)('persists only the requested %s resource', async (resource) => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true, browserPermissionResource: resource });
    await user.click(screen.getByRole('button', { name: resource === 'browse' ? '以后允许在此网站浏览' : '以后允许向此网站上传' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites).toEqual({ 'https://example.com': { ...emptyBrowserSiteRule(), [resource]: 'allow' } });
    expect(config.embeddedSites).toEqual({});
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('the narrow choice grants only this request and writes no site rule', async () => {
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    await userEvent.setup().click(screen.getByRole('button', { name: '仅允许这次' }));
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites).toEqual({});
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('shows and preserves embedded scope without granting the frame as a top-level site', async () => {
    const origin = 'https://frame.example'; const host = 'https://host.example';
    renderDialog({ browserOrigin: origin, browserPageOrigin: host, allowPersistentGrant: true });
    expect(screen.getByText(/仅在 https:\/\/host.example 中/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites[origin]).toBeUndefined();
    expect(config.embeddedSites[host][origin]).toEqual({ upload: 'inherit', script: 'inherit', browse: 'allow' });
  });
  it('a multi-target grant writes every named scope and no other resource or site', async () => {
    const host = 'https://host.example'; const frame = 'https://frame.example';
    renderDialog({ browserOrigin: host, allowPersistentGrant: true, browserPermissionTargets: [{ origin: host }, { origin: frame, embeddedIn: host }] });
    expect(screen.getByText(new RegExp(frame))).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites).toEqual({ [host]: { ...emptyBrowserSiteRule(), browse: 'allow' } });
    expect(config.embeddedSites).toEqual({ [host]: { [frame]: { upload: 'inherit', script: 'inherit', browse: 'allow' } } });
  });
  it.each([
    { allowPersistentGrant: false }, { browserOrigin: undefined },
    { browserPermissionTargets: [] },
    { browserEmbeddedOrigins: Array.from({ length: 6 }, (_, i) => `https://f${i}.example`) },
  ])('cannot offer a permanent grant beyond the request authority: %j', (overrides) => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true, ...overrides });
    expect(screen.queryByRole('button', { name: /以后允许/ })).toBeNull();
  });
  it('offers to always allow scripts on the site, and writes only the script permission', async () => {
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true,
      browserPermissionResource: 'script', browserPermissionTargets: [{ origin: 'https://example.com' }] });
    await userEvent.setup().click(screen.getByRole('button', { name: '以后在此网站允许执行脚本' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://example.com'])
      .toEqual({ ...emptyBrowserSiteRule(), script: 'allow' });
  });
  it('a save failure does not approve or hide the pending action', async () => {
    const write = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets').mockResolvedValue(false);
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '仅允许这次' })).toBeEnabled();
    write.mockRestore();
  });

  it('plain command confirmations are unchanged — two buttons, command wording', () => {
    renderDialog({ kind: 'command', browserOrigin: undefined, allowPersistentGrant: undefined });

    expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  // "Danger level decides whether you can settle it once and for all"
  // (permission plan §4.3). The dialog enforces that as a floor, so a caller
  // that misclassifies a high-consequence action still cannot mint a
  // permanent grant from it.
  describe('always-ask floor on the permanent grant', () => {
    it('withholds the permanent option for a danger-level browser action', () => {
      renderDialog({
        browserOrigin: 'https://bank.example.com',
        allowPersistentGrant: true,
        level: 'danger',
      });

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
      // The one-time approval and the block action both remain reachable.
      expect(screen.getByRole('button', { name: '仅允许这次' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('withholds the permanent option for self-extension requests', () => {
      renderDialog({
        kind: 'self-extension',
        browserOrigin: 'https://example.com',
        allowPersistentGrant: true,
      });

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
    });
  });

  // Blocking is the missing half of the site-verdict store: `getSiteVerdict`
  // has honoured 'denied' since v0.39.0 but nothing could write it, so the
  // only way to stop being asked was to approve.
  describe('block this site', () => {
    it('persists a denied verdict and refuses the pending action', async () => {
      const user = userEvent.setup();
      const { onConfirm, onCancel } = renderDialog({
        browserOrigin: 'https://evil.example.com',
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '禁止此网站' }));

      await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://evil.example.com']?.blocked).toBe(true));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('is offered even when a permanent grant is forbidden (e.g. a high-risk site)', () => {
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: false });

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('overwrites an existing allow verdict for the same origin', async () => {
      const user = userEvent.setup();
      setMigratedBrowserSettings({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { 'https://example.com': { ...emptyBrowserSiteRule(), browse: 'allow' } } } });
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      await user.click(screen.getByRole('button', { name: '禁止此网站' }));

      await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://example.com']?.blocked).toBe(true));
    });

    it('is not offered when the origin is unknown or the request is not a browser action', () => {
      renderDialog({ browserOrigin: undefined, allowPersistentGrant: true });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
      cleanup();

      renderDialog({ kind: 'command', browserOrigin: 'https://example.com' });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
    });
  });

  /**
   * Acceptance F5 — the upload question.
   *
   * It used to be asked with the generic browser box: the heading said
   * 「浏览器操作确认」, the line under it named `abu-browser__upload_file`, and
   * the button said 「确认执行」. A person reading that is told the name of an
   * identifier only this codebase uses, and is not told the one thing that
   * matters — that files are about to leave their machine, and for where.
   *
   * The site-scoped affordances are asserted alongside the wording on
   * purpose: an upload is a browser action, and the way this could go wrong
   * is by giving it its own heading and silently dropping its 「禁止此网站」
   * row along with the kind check that offered it.
   */
  describe('an upload asks its own question', () => {
    function renderUpload(overrides: Partial<CommandConfirmRequest> = {}) {
      return renderDialog({
        kind: 'browser-upload',
        command: '报价.csv (18 B), 明细.xlsx (1.2 MB) — 1.2 MB',
        browserUploadFileCount: 2,
        browserOrigin: 'https://oa.example.com',
        allowPersistentGrant: false,
        ...overrides,
      });
    }

    it('says how many files are going where, and confirms with 「确认上传」', () => {
      renderUpload();

      expect(screen.getByText('上传 2 个文件到 oa.example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '确认上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    });

    it('never shows the internal tool name', () => {
      renderUpload();

      expect(document.body.textContent).not.toContain('abu-browser__');
      expect(screen.queryByText('浏览器操作确认')).toBeNull();
    });

    it('lists the files, their sizes and the total', () => {
      renderUpload();

      expect(screen.getByText('报价.csv (18 B), 明细.xlsx (1.2 MB) — 1.2 MB')).toBeInTheDocument();
    });

    it('counts one file in the singular', () => {
      renderUpload({ browserUploadFileCount: 1, command: '报价.csv (18 B)' });

      expect(screen.getByText('上传 1 个文件到 oa.example.com')).toBeInTheDocument();
    });

    /**
     * The files are going to a region the page merely hosts, not to the site
     * the user is looking at — the one distinction that changes whether this
     * upload is what they meant.
     */
    it('says so when the target is a region embedded in the page', () => {
      renderUpload({
        browserOrigin: 'https://vendor.example.net',
        browserPageOrigin: 'https://oa.example.com',
      });

      expect(
        screen.getByText('上传 2 个文件到 vendor.example.net（页面内嵌区域）'),
      ).toBeInTheDocument();
    });

    it('names the site generically when the origin could not be resolved', () => {
      renderUpload({ browserOrigin: undefined });

      expect(screen.getByText('上传 2 个文件到 这个网站')).toBeInTheDocument();
    });

    it('keeps the site grant and the block row an upload is entitled to', () => {
      renderUpload({ allowPersistentGrant: true });

      // The once/always split survives, in the upload's own verb.
      expect(screen.getByRole('button', { name: '仅本次上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '以后允许向此网站上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('reads the same way in the other locale', () => {
      initLanguage('en-US');
      renderUpload();

      expect(screen.getByText('Upload 2 files to oa.example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm upload' })).toBeInTheDocument();
      initLanguage('zh-CN');
    });

    it('reads the same way in the other locale for one file', () => {
      initLanguage('en-US');
      renderUpload({ browserUploadFileCount: 1, command: 'quote.csv (18 B)' });

      expect(screen.getByText('Upload 1 file to oa.example.com')).toBeInTheDocument();
      initLanguage('zh-CN');
    });
  });
});

import { act as auditAct, fireEvent as auditFire } from '@testing-library/react';
import {createBrowserPermissionConfig as auditConfig} from '@/core/permissions/browserPermissionConfig';
describe('audit-review dialog replacement', () => {
 afterEach(() => {cleanup();vi.restoreAllMocks();});
 it('audit-ui: releases saving state for the next request without confirming the old one', async () => {
  initLanguage('zh-CN');
  useSettingsStore.setState({browserPermissionConfigV2:auditConfig()});
  let release!: (value: boolean) => void; let guard!: () => boolean;
  const write=vi.spyOn(useSettingsStore.getState(),'grantBrowserPermissionTargets').mockImplementation((_resource,_targets,current)=>{guard=current!;return new Promise(resolve=>{release=resolve;});});
  const first={command:'first',reason:'first',level:'warn',kind:'browser',browserOrigin:'https://first.example',browserPermissionResource:'browse',browserPermissionTargets:[{origin:'https://first.example'}],allowPersistentGrant:true} as CommandConfirmRequest;
  const next={...first,command:'second',reason:'second',browserOrigin:'https://second.example',browserPermissionResource:'upload',browserPermissionTargets:[{origin:'https://second.example'}]} as CommandConfirmRequest;
  const confirm=vi.fn(),cancel=vi.fn();
  const view=render(<CommandConfirmDialog request={first} onConfirm={confirm} onCancel={cancel}/>);
  auditFire.click(screen.getByRole('button',{name:'以后允许在此网站浏览'}));
  view.rerender(<CommandConfirmDialog request={next} onConfirm={confirm} onCancel={cancel}/>);
  expect(guard()).toBe(false);
  await auditAct(async()=>{release(false);});
  expect(write.mock.calls[0].slice(0,2)).toEqual(['browse',[{origin:'https://first.example'}]]);
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'仅允许这次'})).toBeEnabled();
 });
});

describe('audit-review dialog cancellation',()=>{
 afterEach(()=>{cleanup();vi.restoreAllMocks();});
 it('audit-cancel: ordinary cancellation invalidates the pending grant callback',async()=>{
  initLanguage('zh-CN');useSettingsStore.setState({browserPermissionConfigV2:auditConfig()});
  let release!: (value: boolean) => void; let guard!: () => boolean;
  vi.spyOn(useSettingsStore.getState(),'grantBrowserPermissionTargets').mockImplementation((_resource,_targets,current)=>{guard=current!;return new Promise(resolve=>{release=resolve;});});
  const request={command:'upload',reason:'upload',level:'warn',kind:'browser-upload',browserOrigin:'https://frame.example',browserPageOrigin:'https://host.example',browserPermissionResource:'upload',browserPermissionTargets:[{origin:'https://frame.example',embeddedIn:'https://host.example'}],allowPersistentGrant:true} as CommandConfirmRequest;
  const confirm=vi.fn(),cancel=vi.fn();
  render(<CommandConfirmDialog request={request} onConfirm={confirm} onCancel={cancel}/>);
  auditFire.click(screen.getByRole('button',{name:'以后允许向此网站上传'}));
  auditFire.click(screen.getByRole('button',{name:'取消'}));
  expect(guard()).toBe(false);
  await auditAct(async()=>release(false));
  expect(cancel).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
 });
});

// What an answer means. Each case holds for the window as it was before it became a
// design-system approval layer and holds, unchanged, after.
describe('command approval: only a press on its own buttons answers it', () => {
  const COMMAND = 'echo not-a-real-command';
  const ORIGIN = 'https://example.invalid';

  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ browserPermissionConfigV2: auditConfig() });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function commandRequest(overrides: Partial<CommandConfirmRequest> = {}): CommandConfirmRequest {
    return { command: COMMAND, level: 'warn', reason: 'needs a look', kind: 'command', ...overrides };
  }
  function browserRequest(overrides: Partial<CommandConfirmRequest> = {}): CommandConfirmRequest {
    return {
      command: 'open the page',
      level: 'warn',
      reason: 'needs a look',
      kind: 'browser',
      browserOrigin: ORIGIN,
      browserPermissionResource: 'browse',
      browserPermissionTargets: [{ origin: ORIGIN }],
      allowPersistentGrant: true,
      ...overrides,
    };
  }
  function open(request: CommandConfirmRequest, isRequestActive?: () => boolean) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <CommandConfirmDialog request={request} onConfirm={onConfirm} onCancel={onCancel} isRequestActive={isRequestActive} />,
    );
    return { onConfirm, onCancel, view };
  }
  // The corner button is the one button without words.
  const cornerButton = () => {
    const button = screen.getAllByRole('button').find((candidate) => candidate.textContent === '');
    if (!button) throw new Error('The approval has no corner button');
    return button;
  };
  const buttonNames = () => screen.getAllByRole('button').map((button) => button.textContent).filter((name) => name !== '');
  // A write to the site rules that stays out until the test lets it land.
  function heldWrite(method: 'grantBrowserPermissionTargets' | 'setBrowserSiteBlocked') {
    let release!: (saved: boolean) => void;
    const write = vi.spyOn(useSettingsStore.getState(), method).mockImplementation(
      () => new Promise<boolean>((resolve) => { release = resolve; }),
    );
    return { write, release: (saved: boolean) => auditAct(async () => { release(saved); }) };
  }

  it('answers nothing by opening, and nothing by leaving the page', () => {
    const { onConfirm, onCancel, view } = open(commandRequest());
    expect(screen.getByRole('heading', { name: '操作确认' })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    view.unmount();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels once on Escape and never confirms', async () => {
    const { onConfirm, onCancel } = open(commandRequest());
    await userEvent.setup().keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('never confirms on Enter or Space pressed right after it opened', async () => {
    const user = userEvent.setup();
    const { onConfirm } = open(commandRequest());
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels from the corner button', async () => {
    const { onConfirm, onCancel } = open(commandRequest());
    await userEvent.setup().click(cornerButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels from 「取消」', async () => {
    const { onConfirm, onCancel } = open(commandRequest());
    await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once from 「确认执行」', async () => {
    const { onConfirm, onCancel } = open(commandRequest());
    await userEvent.setup().click(screen.getByRole('button', { name: '确认执行' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('confirms nothing and writes no site rule for a request that is no longer the pending one', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets');
    const block = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteBlocked');
    const { onConfirm, onCancel } = open(browserRequest(), () => false);
    await user.click(screen.getByRole('button', { name: '仅允许这次' }));
    await user.click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await user.click(screen.getByRole('button', { name: '禁止此网站' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });

  it('has no confirming control for a blocked command', () => {
    open(commandRequest({ level: 'block' }));
    expect(screen.getByRole('heading', { name: '操作已阻止' })).toBeInTheDocument();
    expect(buttonNames()).toEqual(['取消']);
  });

  it('has no confirming control for a blocked browser action; blocking the site stays', () => {
    open(browserRequest({ level: 'block' }));
    expect(buttonNames()).toEqual(['取消', '禁止此网站']);
  });

  it('fires no second action while a standing grant is being saved', async () => {
    const user = userEvent.setup();
    const { write, release } = heldWrite('grantBrowserPermissionTargets');
    const block = vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteBlocked');
    const { onConfirm, onCancel } = open(browserRequest());
    await user.click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    expect(write).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '仅允许这次' }));
    await user.click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await user.click(screen.getByRole('button', { name: '禁止此网站' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(block).not.toHaveBeenCalled();

    await release(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires no second action while the site is being blocked', async () => {
    const user = userEvent.setup();
    const { write: block, release } = heldWrite('setBrowserSiteBlocked');
    const grant = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets');
    const { onConfirm, onCancel } = open(browserRequest());
    await user.click(screen.getByRole('button', { name: '禁止此网站' }));
    expect(block.mock.calls).toEqual([[ORIGIN, true]]);

    await user.click(screen.getByRole('button', { name: '仅允许这次' }));
    await user.click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await user.click(screen.getByRole('button', { name: '禁止此网站' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(block).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();

    await release(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('stays on screen, unanswered, when blocking the site cannot be saved', async () => {
    vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteBlocked').mockResolvedValue(false);
    const { onConfirm, onCancel } = open(browserRequest());
    await userEvent.setup().click(screen.getByRole('button', { name: '禁止此网站' }));
    expect(screen.getByRole('alert')).toHaveTextContent('未能保存，已恢复上次确认的设置');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '浏览器操作确认' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仅允许这次' })).toBeEnabled();
  });

  it('stays on screen, unanswered, when the standing grant cannot be saved', async () => {
    vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets').mockResolvedValue(false);
    const { onConfirm, onCancel } = open(browserRequest());
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '浏览器操作确认' })).toBeInTheDocument();
  });

  it('shows the command once, as text, and the site address in no attribute but the title of its two site buttons', () => {
    open(browserRequest({ command: COMMAND }));
    expect(document.body.textContent?.split(COMMAND)).toHaveLength(2);

    const carriers: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        const watched = attribute.name === 'title' || attribute.name === 'aria-label' || attribute.name.startsWith('data-');
        if (!watched) continue;
        if (attribute.value.includes('example.invalid') || attribute.value.includes('not-a-real-command')) {
          carriers.push(`${element.textContent} ${attribute.name}=${attribute.value}`);
        }
      }
    }
    expect(carriers).toEqual([
      `以后允许在此网站浏览 title=${ORIGIN}`,
      `禁止此网站 title=${ORIGIN}`,
    ]);
  });
});

// The window as a design-system approval layer: where the focus starts, what the keys do,
// and what the windows around it can and cannot do to it.
describe('command approval as an approval layer', () => {
  const COMMAND = 'echo not-a-real-command';
  const ORIGIN = 'https://example.invalid';

  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ browserPermissionConfigV2: auditConfig() });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const command = (overrides: Partial<CommandConfirmRequest> = {}): CommandConfirmRequest => (
    { command: COMMAND, level: 'warn', reason: 'needs a look', kind: 'command', ...overrides }
  );
  const browser = (overrides: Partial<CommandConfirmRequest> = {}): CommandConfirmRequest => ({
    command: 'open the page',
    level: 'warn',
    reason: 'needs a look',
    kind: 'browser',
    browserOrigin: ORIGIN,
    browserPermissionResource: 'browse',
    browserPermissionTargets: [{ origin: ORIGIN }],
    allowPersistentGrant: true,
    ...overrides,
  });
  function open(request: CommandConfirmRequest) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = render(<CommandConfirmDialog request={request} onConfirm={onConfirm} onCancel={onCancel} />);
    return { onConfirm, onCancel, view };
  }
  const approval = (name = '操作确认') => screen.getByRole('alertdialog', { name });
  const button = (name: string) => screen.getByRole('button', { name });

  it('is an alert dialog named by its title, with a named close button in the corner', () => {
    open(command());
    expect(approval()).toHaveAttribute('data-ds-layer');
    expect(approval()).toHaveAccessibleDescription('以下命令需要你的确认才能执行：');
    expect(button('关闭')).toBeInTheDocument();
  });

  it.each([
    ['a command', command(), '操作确认'],
    ['a dangerous command', command({ level: 'danger' }), '危险操作确认'],
    ['a blocked command', command({ level: 'block' }), '操作已阻止'],
    ['a browser action with a standing grant on offer', browser(), '浏览器操作确认'],
  ] as const)('opens with the focus on 「取消」: %s', (_name, request, title) => {
    open(request);
    expect(approval(title)).toBeInTheDocument();
    expect(button('取消')).toHaveFocus();
  });

  it('cancels on Enter pressed right after it opened', async () => {
    const { onConfirm, onCancel } = open(command());
    await userEvent.setup().keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Space pressed right after it opened', async () => {
    const { onConfirm, onCancel } = open(browser());
    await userEvent.setup().keyboard(' ');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does nothing on a press on the scrim or on the page behind it', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <>
        <p>Elsewhere</p>
        <CommandConfirmDialog request={command()} onConfirm={onConfirm} onCancel={onCancel} />
      </>,
    );
    await user.click(document.querySelector('.bg-scrim') as Element);
    await user.click(screen.getByText('Elsewhere'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(approval()).toBeInTheDocument();
  });

  it('keeps Tab among its own controls', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Button>Behind</Button>
        <CommandConfirmDialog request={command()} onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );
    const seen: (string | null)[] = [];
    for (let presses = 0; presses < 4; presses += 1) {
      await user.tab();
      seen.push(document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label') || null);
    }
    expect(seen).toEqual(['确认执行', '关闭', '取消', '确认执行']);
  });

  describe('the windows around it', () => {
    interface PageProps {
      approvalShown?: boolean;
      second?: boolean;
      search?: boolean;
      form?: boolean;
      busy?: boolean;
      dirty?: boolean;
      question?: boolean;
    }
    function harness() {
      const calls = {
        onConfirm: vi.fn(), onCancel: vi.fn(), secondConfirm: vi.fn(), secondCancel: vi.fn(),
        onSearch: vi.fn(), onForm: vi.fn(), onQuestion: vi.fn(), formAction: vi.fn(),
      };
      function Page({ approvalShown = false, second = false, search = false, form = false, busy = false, dirty = false, question = false }: PageProps) {
        return (
          <>
            {approvalShown && <CommandConfirmDialog request={command()} onConfirm={calls.onConfirm} onCancel={calls.onCancel} />}
            {second && (
              <CommandConfirmDialog
                request={command({ command: 'echo not-a-real-command --again', level: 'danger' })}
                onConfirm={calls.secondConfirm}
                onCancel={calls.secondCancel}
              />
            )}
            <Dialog open={search} onOpenChange={calls.onSearch} title="Search" />
            <Dialog open={form} onOpenChange={calls.onForm} busy={busy} dirty={dirty} title="Add a service">
              <TextField aria-label="Address" defaultValue="https://example.invalid/v1" />
              <Button onClick={calls.formAction}>Check</Button>
            </Dialog>
            <Dialog open={question} onOpenChange={calls.onQuestion} role="alertdialog" title="Remove this item?" footer={<Button>Keep</Button>} />
          </>
        );
      }
      return { calls, Page };
    }
    const unanswered = (calls: ReturnType<typeof harness>['calls']) => {
      expect(calls.onConfirm).not.toHaveBeenCalled();
      expect(calls.onCancel).not.toHaveBeenCalled();
    };
    // The box of a window that is in the page, on screen or hidden.
    const box = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
      .find((element) => element.querySelector('h2')?.textContent === title) ?? null;

    it('turns away a window that opens while it is on screen, and is not answered by that', () => {
      const { calls, Page } = harness();
      const view = render(<Page approvalShown />);
      view.rerender(<Page approvalShown search />);

      expect(calls.onSearch.mock.calls).toEqual([[false]]);
      expect(box('Search')).toBeNull();
      expect(approval()).toHaveAttribute('data-state', 'open');
      expect(button('取消')).toHaveFocus();
      unanswered(calls);

      view.rerender(<Page approvalShown />);
      unanswered(calls);
    });

    it('takes the place of a window with nothing to lose: that window is closed, the approval is not answered', () => {
      const { calls, Page } = harness();
      const view = render(<Page search />);
      view.rerender(<Page search approvalShown />);

      expect(calls.onSearch.mock.calls).toEqual([[false]]);
      expect(approval()).toBeInTheDocument();
      unanswered(calls);
    });

    it('keeps a second approval off the page until the first is answered; neither answers the other', () => {
      const { calls, Page } = harness();
      const view = render(<Page approvalShown />);
      view.rerender(<Page approvalShown second />);

      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      expect(box('危险操作确认')).toBeNull();
      expect(screen.queryByText('echo not-a-real-command --again')).toBeNull();
      unanswered(calls);
      expect(calls.secondConfirm).not.toHaveBeenCalled();
      expect(calls.secondCancel).not.toHaveBeenCalled();

      // The first is answered: its owner takes it off the page.
      view.rerender(<Page second />);
      expect(approval('危险操作确认')).toBeInTheDocument();
      expect(button('取消')).toHaveFocus();
      unanswered(calls);
      expect(calls.secondConfirm).not.toHaveBeenCalled();
      expect(calls.secondCancel).not.toHaveBeenCalled();
    });

    it('answers only the approval on screen when Escape is pressed with a second one waiting', async () => {
      const { calls, Page } = harness();
      render(<Page approvalShown second />);
      await userEvent.setup().keyboard('{Escape}');
      expect(calls.onCancel).toHaveBeenCalledTimes(1);
      expect(calls.onConfirm).not.toHaveBeenCalled();
      expect(calls.secondConfirm).not.toHaveBeenCalled();
      expect(calls.secondCancel).not.toHaveBeenCalled();
    });

    it('waits, off the page and unanswered, while the user is asked about unsaved input; Discard shows it', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form dirty />);
      view.rerender(<Page form dirty approvalShown />);

      expect(screen.getByRole('alertdialog', { name: '放弃这些内容？' })).toBeInTheDocument();
      expect(box('操作确认')).toBeNull();
      unanswered(calls);
      expect(calls.onForm).not.toHaveBeenCalled();

      await user.click(button('放弃'));
      expect(calls.onForm.mock.calls).toEqual([[false]]);
      expect(approval()).toBeInTheDocument();
      unanswered(calls);
    });

    it('goes on waiting, unanswered, when the user keeps the unsaved input, and is shown once that window has closed', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form dirty />);
      view.rerender(<Page form dirty approvalShown />);
      await user.click(button('继续填写'));

      expect(box('操作确认')).toBeNull();
      expect(calls.onForm).not.toHaveBeenCalled();
      unanswered(calls);

      view.rerender(<Page approvalShown />);
      expect(approval()).toBeInTheDocument();
      unanswered(calls);
    });

    it('has a window with work in progress step aside, untouched, and return when the approval is answered', async () => {
      const user = userEvent.setup();
      const { calls, Page } = harness();
      const view = render(<Page form busy dirty />);
      const form = box('Add a service');
      view.rerender(<Page form busy dirty approvalShown />);

      expect(box('Add a service')).toBe(form);
      expect(form).toHaveAttribute('hidden');
      expect(screen.queryByRole('dialog', { name: 'Add a service' })).toBeNull();
      expect(screen.queryByRole('alertdialog', { name: '放弃这些内容？' })).toBeNull();
      expect(approval()).toBeInTheDocument();
      expect(button('取消')).toHaveFocus();
      expect(calls.onForm).not.toHaveBeenCalled();
      unanswered(calls);

      // The keyboard acts on the approval alone while the window is hidden.
      await user.keyboard('{Enter}');
      expect(calls.formAction).not.toHaveBeenCalled();
      expect(calls.onForm).not.toHaveBeenCalled();
      expect(calls.onCancel).toHaveBeenCalledTimes(1);
      expect(calls.onConfirm).not.toHaveBeenCalled();

      view.rerender(<Page form busy dirty />);
      expect(box('Add a service')).toBe(form);
      expect(form).not.toHaveAttribute('hidden');
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.invalid/v1');
      expect(calls.onForm).not.toHaveBeenCalled();
    });

    it('is not answered by a question that is asked over it and answered', async () => {
      const { calls, Page } = harness();
      const view = render(<Page approvalShown />);
      view.rerender(<Page approvalShown question />);
      // The question is the top layer; the approval stays open under it.
      expect(screen.getByRole('alertdialog', { name: 'Remove this item?' })).toBeInTheDocument();
      expect(box('操作确认')).toHaveAttribute('data-state', 'open');

      await userEvent.setup().keyboard('{Escape}');
      expect(calls.onQuestion.mock.calls).toEqual([[false]]);
      unanswered(calls);

      view.rerender(<Page approvalShown />);
      unanswered(calls);
      expect(approval()).toBeInTheDocument();
    });

    it('has an open question step aside, unanswered, and return', () => {
      const { calls, Page } = harness();
      const view = render(<Page question />);
      const asked = box('Remove this item?');
      view.rerender(<Page question approvalShown />);

      expect(asked).toHaveAttribute('hidden');
      expect(calls.onQuestion).not.toHaveBeenCalled();
      expect(approval()).toBeInTheDocument();
      unanswered(calls);

      view.rerender(<Page question />);
      expect(asked).not.toHaveAttribute('hidden');
      expect(calls.onQuestion).not.toHaveBeenCalled();
    });
  });

  describe('what it shows', () => {
    const levelIcon = () => approval(document.querySelector('h2')?.textContent ?? '').querySelector('svg[width="20"]');

    it.each([
      ['warn', 'text-warning'],
      ['danger', 'text-danger'],
      ['block', 'text-danger'],
      ['safe', 'text-success'],
    ] as const)('marks the %s level with a status icon above the command', (level, tone) => {
      open(command({ level }));
      expect(levelIcon()).toHaveClass(tone);
      expect(levelIcon()).toHaveAttribute('aria-hidden', 'true');
    });

    it.each([
      ['warn', 'status'],
      ['safe', 'status'],
      ['danger', 'alert'],
      ['block', 'alert'],
    ] as const)('gives the reason of a %s request as an inline message', (level, role) => {
      open(command({ level }));
      expect(screen.getByRole(role)).toHaveTextContent('needs a look');
    });

    it('shows no reason block without a reason', () => {
      open(command({ reason: '' }));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows the command in the code font, in an element E2E reads as code', () => {
      open(command());
      const text = screen.getByText(COMMAND);
      expect(text.tagName).toBe('CODE');
      expect(text.closest('pre')).toHaveClass('font-code');
    });

    it('has one filled button, the one-time confirmation', () => {
      open(browser());
      const filled = screen.getAllByRole('button').filter((candidate) => candidate.classList.contains('bg-emphasis'));
      expect(filled.map((candidate) => candidate.textContent)).toEqual(['仅允许这次']);
      expect(button('禁止此网站')).toHaveClass('text-danger');
    });

    it('keeps its buttons focusable and inert while a site rule is being saved; 「取消」 still cancels', async () => {
      const user = userEvent.setup();
      vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets').mockImplementation(() => new Promise<boolean>(() => undefined));
      const { onConfirm, onCancel } = open(browser());
      await user.click(button('以后允许在此网站浏览'));

      for (const name of ['仅允许这次', '以后允许在此网站浏览', '禁止此网站']) {
        expect(button(name)).toHaveAttribute('aria-disabled', 'true');
        expect(button(name)).not.toBeDisabled();
      }
      expect(button('取消')).not.toHaveAttribute('aria-disabled');
      expect(button('以后允许在此网站浏览')).toHaveFocus();

      await user.click(button('取消'));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('puts a failed save above the command, as an alert', async () => {
      vi.spyOn(useSettingsStore.getState(), 'setBrowserSiteBlocked').mockResolvedValue(false);
      open(browser({ command: COMMAND }));
      await userEvent.setup().click(button('禁止此网站'));
      const failed = screen.getByRole('alert');
      expect(failed).toHaveTextContent('未能保存，已恢复上次确认的设置');
      expect(failed.compareDocumentPosition(screen.getByText(COMMAND)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
