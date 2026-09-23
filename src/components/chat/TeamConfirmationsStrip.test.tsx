// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPermissionConfig, emptyBrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests } from '@/stores/settingsStore';
import { useTeamConfirmationStore, type TeamConfirmationInput } from '@/stores/teamConfirmationStore';
import type { Conversation } from '@/types';
import TeamConfirmationsStrip from './TeamConfirmationsStrip';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args) }));
const enqueueUserInput = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/core/agent/userInputQueue', () => ({ enqueueUserInput: (...args: unknown[]) => enqueueUserInput(...args) }));

function conversation(status: Conversation['status']): Conversation {
  return { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status, messages: [] };
}

const identity = { toolName: 'run_command', parametersDigest: 'p', cwd: '/project', loopId: 'original', callId: 'call', dispatchId: 'leader', dispatchFingerprint: 'leader', requestOrdinal: 1 };
const emptyConfirmations = { pending: {}, approvedOnce: {}, taskRules: {}, retrySelections: {}, currentTaskByConversation: {}, stopped: {} };

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
function restoreNavigatorLocks() {
  if (originalLocksDescriptor) Object.defineProperty(navigator, 'locks', originalLocksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
}

describe('TeamConfirmationsStrip', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState(emptyConfirmations);
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); restoreNavigatorLocks(); });

  it('renders nothing without pending confirmations', () => {
    const { container } = render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('approving a command stores a one-shot approval and asks the idle leader to re-run that step', async () => {
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'zz发布员', reason: '发布' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('zz发布员');
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('/project');
    fireEvent.click(screen.getByRole('button', { name: '仅本次补跑允许: npm publish' }));
    expect(useTeamConfirmationStore.getState().approvedOnce).toEqual({});
    expect(Object.keys(useTeamConfirmationStore.getState().retrySelections)).toHaveLength(1);
    expect(screen.queryByText('工作目录:')).toBeNull();
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('zz发布员');
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('npm publish');
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('approving file access never grants process-wide permission; the selected retry is queued with its identity', () => {
    useChatStore.setState({ conversations: { c1: conversation('running') } });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'file', detail: '/tmp/report', path: '/tmp/report', capability: 'write', member: 'zz撰写员' });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'rm -rf build', member: 'zz取数员' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '仅本次补跑允许: /tmp/report' }));
    expect(usePermissionStore.getState().hasPermission('/tmp/report', 'write')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '拒绝: rm -rf build' }));
    expect(enqueueUserInput).toHaveBeenCalledTimes(2);
    expect(String(enqueueUserInput.mock.calls[1][1])).toContain('拒绝');
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });
  it('shows a revocable task rule, and disables legacy approvals', () => {
    useTeamConfirmationStore.getState().add({ identity: { ...identity, scope: 'prefix:npm run' }, conversationId: 'c1', kind: 'command', level: 'warn', detail: 'npm run build', member: 'A' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '本次补跑运行内都允许此请求: npm run build' }));
    expect(Object.keys(useTeamConfirmationStore.getState().taskRules)).toHaveLength(1);
    expect(runAgentLoopDispatched.mock.calls[0][2]).toMatchObject({ continuesTeamTask: true });
    fireEvent.click(screen.getByRole('button', { name: '撤销规则' }));
    expect(useTeamConfirmationStore.getState().taskRules).toEqual({});
    act(() => { useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'command', detail: 'legacy' }); });
    expect(screen.getByRole('button', { name: '仅本次补跑允许: legacy' })).toBeDisabled();
  });

});

/**
 * P1-a — the strip must be able to express a SCOPE.
 *
 * "Allow this retry" and the run rule are both keyed on the exact parameters,
 * so a member filling a form was asked once per field. The site grant is the
 * scope the browser gate actually consults, and the strip may offer it only
 * where the always-ask floor allows a standing grant at all.
 */
describe('TeamConfirmationsStrip — per-site grant (P1-a)', () => {
  const ORIGIN = 'http://127.0.0.1:8765';
  const browserRequest = (overrides: Partial<TeamConfirmationInput> = {}): TeamConfirmationInput => ({
    identity: { ...identity, toolName: 'fill' },
    conversationId: 'c1',
    kind: 'browser',
    detail: 'fill #q',
    member: 'zz填表员',
    browserOrigin: ORIGIN,
    browserOperationClass: 'interactive',
    browserPermissionResource: 'browse',
    browserPermissionTargets: [{ origin: ORIGIN }],
    allowPersistentGrant: true,
    level: 'warn',
    ...overrides,
  });
  const renderWith = (item: TeamConfirmationInput) => {
    useTeamConfirmationStore.getState().add(item);
    render(<TeamConfirmationsStrip conversationId="c1" />);
  };
  const allowSiteButton = () => screen.queryByTestId('team-confirmation-allow-site');

  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState(emptyConfirmations);
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    // `browserSitePermissions` is branded so only the store's own action can
    // mint one; a test reset has to go around the brand, not through it.
    let writes = Promise.resolve<unknown>(undefined);
    const browserNavigator = navigator;
    Object.defineProperty(browserNavigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => {
      const job = writes.then(callback); writes = job.catch(() => undefined); return job;
    } } });
    vi.stubGlobal('navigator', browserNavigator);
    __resetBrowserConfigPersistenceForTests();
    localStorage.clear();
    setMigratedBrowserSettings({ browserPermissionConfigV2: createBrowserPermissionConfig() });
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); restoreNavigatorLocks(); });

  it('A: offers the site grant and names the site on the row', () => {
    renderWith(browserRequest());
    expect(allowSiteButton()).toHaveTextContent('以后允许在此网站浏览');
    expect(allowSiteButton()).toHaveAttribute('aria-label', '以后允许在此网站浏览');
    expect(screen.getByTestId('team-confirmation-item').textContent).toContain(`网站: ${ORIGIN}`);
  });

  it('B: no grant when the requester did not allow persistence', () => {
    renderWith(browserRequest({ allowPersistentGrant: false }));
    expect(allowSiteButton()).toBeNull();
  });

  it('C: no grant above the always-ask floor', () => {
    renderWith(browserRequest({ level: 'danger' }));
    expect(allowSiteButton()).toBeNull();
  });

  it('D: no grant without an origin to key it to', () => {
    renderWith(browserRequest({ browserOrigin: undefined }));
    expect(allowSiteButton()).toBeNull();
  });

  it('E: no grant for a non-browser request', () => {
    renderWith(browserRequest({ kind: 'command', detail: 'npm publish' }));
    expect(allowSiteButton()).toBeNull();
  });

  /**
   * A row in `pending` is persisted, so it can outlive the verdict it was
   * captured under: the user blocks the origin afterwards (Settings › 网站授权,
   * or a dialog in another conversation) and the frozen payload still says
   * "offer a grant". A denied site never reaches a dialog, and the Settings row
   * shows what it is changing — the strip must not be the one surface that can
   * undo a block without showing the current verdict.
   */
  it('G: a site the user blocked is never offered, and the offer returns the moment the block is lifted', async () => {
    renderWith(browserRequest());
    expect(allowSiteButton()).not.toBeNull();

    // Blocking from anywhere else — same store, no remount of this strip.
    await act(async () => { await useSettingsStore.getState().setBrowserSiteBlocked(ORIGIN, true); });
    expect(allowSiteButton()).toBeNull();
    // The row's other two approvals are untouched: the block is about the SITE.
    expect(screen.getByRole('button', { name: '仅本次补跑允许: fill #q' })).toBeEnabled();

    // Lifting the block brings the offer back live, still without a remount.
    await act(async () => { await useSettingsStore.getState().removeBrowserSiteRule(ORIGIN, useSettingsStore.getState().browserPermissionConfigV2.sites[ORIGIN]); });
    expect(allowSiteButton()).not.toBeNull();
  });

  it('H: clicking through a block that landed after paint writes nothing', async () => {
    renderWith(browserRequest());
    const button = allowSiteButton()!;
    // The button is captured while the site is still `default`, then the block
    // lands without React repainting it — the click path has to refuse too.
    setMigratedBrowserSettings({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { [ORIGIN]: { ...emptyBrowserSiteRule(), blocked: true } } } });
    const setSite = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets');
    await act(async () => { fireEvent.click(button); });

    expect(useSettingsStore.getState().browserPermissionConfigV2.sites[ORIGIN].blocked).toBe(true);
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites[ORIGIN].blocked).toBe(true);
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(useTeamConfirmationStore.getState().retrySelections).toEqual({});
    setSite.mockRestore();
  });

  it('F: granting writes the resource once and retries only this call', async () => {
    const setSite = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets');
    renderWith(browserRequest());
    await act(async () => { fireEvent.click(allowSiteButton()!); });

    expect(setSite).toHaveBeenCalledTimes(1);
    expect(setSite).toHaveBeenCalledWith('browse', [{ origin: ORIGIN }], expect.any(Function));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2.sites[ORIGIN]).toEqual({ ...emptyBrowserSiteRule(), browse: 'allow' }));
    await waitFor(() => expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1));
    // The grant covers the site; it mints no reusable run rule.
    expect(useTeamConfirmationStore.getState().taskRules).toEqual({});
    setSite.mockRestore();
  });
});

import {createBrowserPermissionConfig as auditTeamConfig} from '@/core/permissions/browserPermissionConfig';
describe('audit-review team save cancellation',()=>{
 beforeEach(()=>{initLanguage('zh-CN');useSettingsStore.setState({browserPermissionConfigV2:auditTeamConfig()});useTeamConfirmationStore.setState(emptyConfirmations);useChatStore.setState({conversations:{c1:conversation('running')}});vi.clearAllMocks();});
 afterEach(()=>{cleanup();vi.restoreAllMocks();});
 it.each(['removed','replaced'])('audit-cancel: team %s request cannot finish its pending upload grant',async(condition)=>{
  let release!: (value: boolean) => void; let guard!: () => boolean;
  const save=vi.spyOn(useSettingsStore.getState(),'grantBrowserPermissionTargets').mockImplementation((_resource,_targets,current)=>{guard=current!;return new Promise(resolve=>{release=resolve;});});
  const target={origin:'https://frame.example',embeddedIn:'https://host.example'};
  const entry=useTeamConfirmationStore.getState().add({conversationId:'c1',kind:'browser-upload',detail:'upload file',identity:{...identity,toolName:'abu-browser__upload_file'},browserOrigin:target.origin,browserOperationClass:'upload',browserPermissionResource:'upload',browserPermissionTargets:[target],allowPersistentGrant:true,level:'warn'});
  if (!entry) throw new Error('test confirmation was not registered');
  render(<TeamConfirmationsStrip conversationId='c1'/>);
  fireEvent.click(screen.getByTestId('team-confirmation-allow-site'));
  expect(save.mock.calls[0].slice(0,2)).toEqual(['upload',[target]]);
  if(condition==='removed')fireEvent.click(screen.getByRole('button',{name:'拒绝: upload file'}));
  else act(()=>useTeamConfirmationStore.setState({pending:{[entry.id]:{...entry,browserPermissionResource:'browse',browserPermissionTargets:[{origin:'https://different.example'}]}}}));
  expect(guard()).toBe(false);
  await act(async()=>release(false));
  expect(useTeamConfirmationStore.getState().retrySelections).toEqual({});
  expect(runAgentLoopDispatched).not.toHaveBeenCalled();
  expect(enqueueUserInput).toHaveBeenCalledTimes(condition==='removed'?1:0);
 });
});
