// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPermissionConfig, emptyBrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { admitDispatches, clearRunBounds, getRunBounds, recordDispatchOutcome } from '@/core/team/teamRunBounds';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests } from '@/stores/settingsStore';
import { useTeamConfirmationStore, type TeamConfirmationInput } from '@/stores/teamConfirmationStore';
import type { Conversation } from '@/types';
import TeamConfirmationsStrip from './TeamConfirmationsStrip';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
const forgiveTeamBrowserDenials = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args),
  forgiveTeamBrowserDenials: (...args: unknown[]) => forgiveTeamBrowserDenials(...args),
}));
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

  it('a request that must be asked every time offers only "只允许这一次", and that retries the same step inside the task', () => {
    useTeamConfirmationStore.getState().add({ identity: { ...identity, scope: 'prefix:rm -rf' }, conversationId: 'c1', kind: 'command', level: 'danger', detail: 'rm -rf ./old', member: 'zz发布员', reason: '清理' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    const row = screen.getByTestId('team-confirmation-item');
    expect(row).toHaveTextContent('zz发布员');
    expect(row).toHaveTextContent('工作目录: /project');
    expect(screen.queryByRole('button', { name: '这个任务里都允许: rm -rf ./old' })).toBeNull();
    expect(row).not.toHaveTextContent('不再问');
    const once = screen.getByRole('button', { name: '只允许这一次: rm -rf ./old' });
    expect(once.className).toContain('bg-[var(--abu-clay)]');

    fireEvent.click(once);
    expect(useTeamConfirmationStore.getState().approvedOnce).toEqual({});
    const [selection] = Object.keys(useTeamConfirmationStore.getState().retrySelections);
    expect(selection).toBeDefined();
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched.mock.calls[0][1]).toBe('我同意了zz发布员做「rm -rf ./old」这一次。请用原来的专家、任务和上下文把这一步重新派一次，做完后说明结果。');
    expect(runAgentLoopDispatched.mock.calls[0][2]).toMatchObject({ teamConfirmationRetryId: selection, continuesTeamTask: true });
    expect(forgiveTeamBrowserDenials).toHaveBeenCalledWith('c1');
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('approving file access never grants process-wide permission; while the leader runs, retry and rejection are queued', () => {
    useChatStore.setState({ conversations: { c1: conversation('running') } });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'file', detail: '/tmp/report', path: '/tmp/report', capability: 'write', member: 'zz撰写员' });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'rm -rf build', member: 'zz取数员' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getAllByTestId('team-confirmation-item')[0]).toHaveTextContent('权限：写入');
    fireEvent.click(screen.getByRole('button', { name: '只允许这一次: /tmp/report' }));
    expect(usePermissionStore.getState().hasPermission('/tmp/report', 'write')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '拒绝: rm -rf build' }));
    expect(enqueueUserInput).toHaveBeenCalledTimes(2);
    expect(enqueueUserInput.mock.calls[0].slice(2)).toEqual([false, expect.any(String), true]);
    expect(String(enqueueUserInput.mock.calls[1][1])).toContain('我没有同意zz取数员');
    // 拒绝仍然算拒绝，只有允许会让连续拒绝重新计数
    expect(forgiveTeamBrowserDenials).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('"这个任务里都允许" names what it covers, lists the allowance, and "收回" withdraws it', () => {
    useTeamConfirmationStore.getState().add({ identity: { ...identity, scope: 'prefix:npm run' }, conversationId: 'c1', kind: 'command', level: 'warn', detail: 'npm run build', member: 'A' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmation-item')).toHaveTextContent('A在 /project 里再执行「npm run」开头的命令时不再问');
    const task = screen.getByRole('button', { name: '这个任务里都允许: npm run build' });
    expect(task).toHaveAttribute('data-primary', 'true');
    expect(screen.getByRole('button', { name: '只允许这一次: npm run build' }).className).not.toContain('bg-[var(--abu-clay)]');

    fireEvent.click(task);
    expect(Object.values(useTeamConfirmationStore.getState().taskRules)).toMatchObject([{ category: 'command:["/project","prefix:npm run"]' }]);
    expect(useTeamConfirmationStore.getState().pending).toEqual({});
    expect(forgiveTeamBrowserDenials).toHaveBeenCalledWith('c1');
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched.mock.calls[0][1]).toBe('这个任务里，我同意了刚才请求的这些操作。请让相关专家接着做被挡住的步骤，做完后说明结果。');
    expect(runAgentLoopDispatched.mock.calls[0][2]).toMatchObject({ teamConfirmationRetryId: undefined, continuesTeamTask: true });

    const strip = screen.getByTestId('team-confirmations-strip');
    expect(strip).toHaveTextContent('这个任务里已允许');
    expect(strip).not.toHaveTextContent('需要你确认');
    // 上面没有条目时不画分隔线
    expect(strip.querySelector('.border-t')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收回: A在 /project 里再执行「npm run」开头的命令时不再问' }));
    expect(useTeamConfirmationStore.getState().taskRules).toEqual({});
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('"全部允许" appears for two or more requests and allows every one that has a scope in one follow-up', () => {
    const store = useTeamConfirmationStore.getState();
    store.add({ identity: { ...identity, callId: 'a', scope: 'prefix:npm run' }, conversationId: 'c1', kind: 'command', level: 'warn', detail: 'npm run build', member: 'A' });
    store.add({ identity: { ...identity, callId: 'b', scope: 'write:/project/out' }, conversationId: 'c1', kind: 'file', detail: '/project/out/a.md', path: '/project/out/a.md', capability: 'write', member: 'B' });
    store.add({ identity: { ...identity, callId: 'c', scope: 'prefix:rm -rf' }, conversationId: 'c1', kind: 'command', level: 'danger', detail: 'rm -rf ./old', member: 'A' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('需要你确认（3）');

    fireEvent.click(screen.getByRole('button', { name: '全部允许' }));
    expect(Object.values(useTeamConfirmationStore.getState().taskRules).map((rule) => rule.category).sort())
      .toEqual(['command:["/project","prefix:npm run"]', 'file:write:/project/out']);
    expect(Object.values(useTeamConfirmationStore.getState().pending).map((item) => item.detail)).toEqual(['rm -rf ./old']);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('team-confirmation-item')).toHaveTextContent('rm -rf ./old');
    expect(screen.queryByRole('button', { name: '全部允许' })).toBeNull();
  });

  it('"全部允许" is not offered when no request has a scope', () => {
    const store = useTeamConfirmationStore.getState();
    store.add({ identity: { ...identity, callId: 'a' }, conversationId: 'c1', kind: 'command', level: 'danger', detail: 'rm -rf a', member: 'A' });
    store.add({ identity: { ...identity, callId: 'b' }, conversationId: 'c1', kind: 'command', level: 'danger', detail: 'rm -rf b', member: 'A' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getAllByTestId('team-confirmation-item')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '全部允许' })).toBeNull();
  });

  it('a request saved before this version can no longer be retried, only rejected', () => {
    useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'command', detail: 'legacy' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmation-item')).toHaveTextContent('这条确认已过期');
    expect(screen.queryByRole('button', { name: '只允许这一次: legacy' })).toBeNull();
    expect(screen.queryByRole('button', { name: '这个任务里都允许: legacy' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '拒绝: legacy' }));
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
  });
});

describe('TeamConfirmationsStrip — stopped hand-offs', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState(emptyConfirmations);
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    vi.clearAllMocks();
  });
  afterEach(() => { cleanup(); clearRunBounds('task-stop'); });

  it('a member stopped after repeated failures shows the last failure; "换个做法再试" lets it take work again', () => {
    for (let i = 0; i < 3; i += 1) recordDispatchOutcome('task-stop', '网页专员', false, '没有交出要求的文件 a.xlsx');
    useTeamConfirmationStore.getState().addStopped({ conversationId: 'c1', taskId: 'task-stop', reason: 'member_blocked', member: '网页专员', count: 3, lastFailure: '没有交出要求的文件 a.xlsx' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    const row = screen.getByTestId('team-stopped-item');
    expect(row).toHaveTextContent('网页专员这件事已经连续失败 3 次，停下了');
    expect(row).toHaveTextContent('最后一次：没有交出要求的文件 a.xlsx');
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('需要你确认（1）');

    fireEvent.click(screen.getByRole('button', { name: '换个做法再试' }));
    expect(getRunBounds('task-stop').consecutiveFailures).toEqual({});
    expect(useTeamConfirmationStore.getState().stopped).toEqual({});
    expect(runAgentLoopDispatched.mock.calls[0][1]).toBe('刚才停下的这一步，请换一个做法再试一次，做完后说明结果。');
    expect(runAgentLoopDispatched.mock.calls[0][2]).toMatchObject({ continuesTeamTask: true });
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('a task that used its hand-off allowance gets a fresh allowance from "换个做法再试"', () => {
    admitDispatches('task-stop', ['A', 'B']);
    useTeamConfirmationStore.getState().addStopped({ conversationId: 'c1', taskId: 'task-stop', reason: 'run_cap', count: 40 });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-stopped-item')).toHaveTextContent('这个任务已经派了 40 次活，停下了');
    fireEvent.click(screen.getByRole('button', { name: '换个做法再试' }));
    expect(getRunBounds('task-stop').dispatches).toBe(0);
  });

  it('"跳过这一步" leaves the bounds alone and tells the leader to carry on without it', () => {
    recordDispatchOutcome('task-stop', 'A', false);
    useTeamConfirmationStore.getState().addStopped({ conversationId: 'c1', taskId: 'task-stop', reason: 'member_blocked', member: 'A', count: 3 });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '跳过这一步' }));
    expect(getRunBounds('task-stop').consecutiveFailures).toEqual({ A: 1 });
    expect(useTeamConfirmationStore.getState().stopped).toEqual({});
    expect(runAgentLoopDispatched.mock.calls[0][1]).toBe('刚才停下的这一步跳过，按受阻处理，继续做其余部分，汇报时说明。');
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

  it('A2: a script request says what it does in words, offers the script grant, and scopes the task allowance to the site', () => {
    renderWith(browserRequest({
      identity: { ...identity, toolName: 'abu-browser__execute_js', scope: ORIGIN },
      detail: `浏览器操作: abu-browser__execute_js (${ORIGIN})`, browserOperationClass: 'scripting', browserPermissionResource: 'script',
      reason: '将在页面里运行一段脚本。脚本能读取这个页面的内容，并以你的身份在页面上操作。',
    }));
    expect(allowSiteButton()).toHaveTextContent('以后在此网站允许执行脚本');
    const row = screen.getByTestId('team-confirmation-item');
    expect(row).toHaveTextContent('zz填表员 想执行：在页面里运行一段脚本');
    expect(row).not.toHaveTextContent('abu-browser__');
    // 风险只在请求原因里说一次
    expect(row.textContent?.match(/以你的身份在页面上操作/g)).toHaveLength(1);
    expect(row).toHaveTextContent(`zz填表员再在 ${ORIGIN} 上执行脚本时不再问`);
    expect(screen.getByRole('button', { name: '这个任务里都允许: 在页面里运行一段脚本' })).toHaveAttribute('data-primary', 'true');
  });

  it('A3: only embedded targets are listed under the site, and a region scope names the page it is embedded in', () => {
    renderWith(browserRequest({
      identity: { ...identity, toolName: 'fill', scope: `https://frame.example in ${ORIGIN}` },
      browserPermissionTargets: [{ origin: ORIGIN }, { origin: 'https://frame.example', embeddedIn: ORIGIN }],
    }));
    const row = screen.getByTestId('team-confirmation-item');
    expect(row).toHaveTextContent(`https://frame.example (${ORIGIN})`);
    expect(row.querySelectorAll('code')).toHaveLength(2);
    expect(row).not.toHaveTextContent('工作目录');
    expect(row).toHaveTextContent(`zz填表员再在 ${ORIGIN} 页面里嵌入的 https://frame.example 上操作时不再问`);
  });

  it('A4: a script inside an embedded region is never offered the site grant — it would open scripts on the whole host site', () => {
    renderWith(browserRequest({
      identity: { ...identity, toolName: 'abu-browser__execute_js' },
      browserOperationClass: 'scripting', browserPermissionResource: 'script',
      browserPermissionTargets: [{ origin: 'https://frame.example', embeddedIn: ORIGIN }, { origin: ORIGIN }],
    }));
    expect(allowSiteButton()).toBeNull();
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
    expect(screen.getByRole('button', { name: '只允许这一次: 操作网页' })).toBeEnabled();

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
  if(condition==='removed')fireEvent.click(screen.getByRole('button',{name:'拒绝: 上传文件'}));
  else act(()=>useTeamConfirmationStore.setState({pending:{[entry.id]:{...entry,browserPermissionResource:'browse',browserPermissionTargets:[{origin:'https://different.example'}]}}}));
  expect(guard()).toBe(false);
  await act(async()=>release(false));
  expect(useTeamConfirmationStore.getState().retrySelections).toEqual({});
  expect(runAgentLoopDispatched).not.toHaveBeenCalled();
  expect(enqueueUserInput).toHaveBeenCalledTimes(condition==='removed'?1:0);
 });
});
