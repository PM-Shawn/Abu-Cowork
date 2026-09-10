// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useSettingsStore } from '@/stores/settingsStore';
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

describe('TeamConfirmationsStrip', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

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
  it('shows a revocable rule with run scope and cwd, and disables legacy approvals', () => {
    const item = useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'A' })!;
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '本次补跑运行内都允许此请求: npm publish' }));
    act(() => useTeamConfirmationStore.getState().beginRetry('c1', 'retry', item.id));
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('结束即失效');
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('/project');
    fireEvent.click(screen.getByRole('button', { name: '撤销规则' }));
    expect(useTeamConfirmationStore.getState().runRules).toEqual({});
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
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    // `browserSitePermissions` is branded so only the store's own action can
    // mint one; a test reset has to go around the brand, not through it.
    useSettingsStore.setState({ browserSitePermissions: {}, browserSiteGrantViaEmbed: {} } as never);
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('A: offers the site grant and names the site on the row', () => {
    renderWith(browserRequest());
    expect(allowSiteButton()).toHaveTextContent(`以后都允许该网站（${ORIGIN}）`);
    expect(allowSiteButton()).toHaveAttribute('aria-label', expect.stringContaining(ORIGIN));
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

  it('F: granting writes the site verdict once and retries only this call', () => {
    const setSite = vi.spyOn(useSettingsStore.getState(), 'setBrowserSitePermission');
    renderWith(browserRequest());
    fireEvent.click(allowSiteButton()!);

    expect(setSite).toHaveBeenCalledTimes(1);
    expect(setSite).toHaveBeenCalledWith(ORIGIN, 'allowed');
    expect(useSettingsStore.getState().browserSitePermissions?.[ORIGIN]).toBe('allowed');
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    // The grant covers the site; it mints no reusable run rule.
    expect(useTeamConfirmationStore.getState().runRules).toEqual({});
    setSite.mockRestore();
  });
});
