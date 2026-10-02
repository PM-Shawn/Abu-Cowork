// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { EnterpriseBinding, EnterpriseConfigSnapshot, EnterpriseMode } from '@/core/enterprise/types';
import { initLanguage } from '@/i18n';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import EnterpriseSection from './EnterpriseSection';

// The two enterprise slots are private-repository code in an enterprise build. Here they are
// markers, so the tests can see where the page puts them and what it hands them.
const brandSlot = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/enterprise/EnterpriseConnectionSlot', () => ({
  default: () => <div data-testid="connection-slot" />,
}));
vi.mock('@/core/enterprise/mounts', () => ({
  MountPoint: (props: Record<string, unknown>) => {
    brandSlot.props.push(props);
    return <div data-testid="brand-slot" />;
  },
}));

// Made-up values. None of the three secrets may reach the page.
const SECRETS = ['access-token-not-real', 'refresh-token-not-real', 'sk-test-not-a-secret'];
const binding: EnterpriseBinding = {
  serverUrl: 'https://abu.example.test',
  orgId: 'org-1',
  orgName: 'Example Org',
  userId: 'user-1',
  userName: 'Ada',
  userEmail: 'ada@example.test',
  deptId: null,
  roleId: null,
  accessToken: SECRETS[0],
  refreshToken: SECRETS[1],
  boundAt: '2026-09-30T08:15:00.000Z',
  llmEndpoint: 'https://abu.example.test/litellm',
  llmVirtualKey: SECRETS[2],
  llmKeyExpiresAt: null,
};
const config = (licenseStatus: EnterpriseConfigSnapshot['licenseStatus']): EnterpriseConfigSnapshot => ({
  brand: { name: 'Example Org', logoUrl: null, primaryColor: null },
  defaultSoul: null,
  policyDefaults: {},
  modules: ['core'],
  licenseStatus,
  serverTime: '2026-10-01T00:00:00.000Z',
  fetchedAt: 0,
});

const unbind = vi.fn(async () => undefined);
// The browser's own question box.
const nativeConfirm = vi.fn<(message?: string) => boolean>();
function show(mode: EnterpriseMode) {
  useEnterpriseStore.setState({ mode, unbind });
  return render(<EnterpriseSection />, { wrapper: DesignSystemProvider });
}
const unbindButton = () => screen.getByRole('button', { name: '解绑企业实例' });
const unbindQuestion = () => screen.findByRole('alertdialog', { name: '解绑后将回到个人模式，企业 Skill / 用量将不再可见。确定解绑？' });
// The answer reaches the page one promise turn after the button is pressed.
const settled = () => act(async () => { await Promise.resolve(); });

// Every place a value could leak to: what is shown, and what assistive technology or a test reads.
function everythingOnThePage(): string {
  const attributes = [...document.querySelectorAll('*')].flatMap((element) => (
    [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`)
  ));
  return [document.body.textContent ?? '', ...attributes].join('\n');
}

describe('EnterpriseSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    brandSlot.props = [];
    unbind.mockClear();
    nativeConfirm.mockReset();
    vi.stubGlobal('confirm', nativeConfirm);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useEnterpriseStore.setState({ mode: { kind: 'personal' } });
  });

  it('shows only the title, the explanation and the connection slot in personal mode', () => {
    show({ kind: 'personal' });
    expect(screen.getByRole('heading', { name: '企业模式' })).toBeInTheDocument();
    expect(screen.getByText('绑定到你公司的 Abu 企业实例，使用统一的 LLM 网关、Skill 和 MCP 资源。')).toBeInTheDocument();
    expect(screen.getByTestId('connection-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-slot')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('已绑定到企业实例')).toBeNull();
  });

  it('shows the instance, the identity and the binding date once bound, and no connection slot', () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    expect(screen.getByRole('heading', { name: '企业模式' })).toBeInTheDocument();
    expect(screen.getByText('已绑定到企业实例')).toBeInTheDocument();
    const row = (label: string) => within(screen.getByText(label).parentElement!);
    expect(row('实例').getByText('https://abu.example.test')).toBeInTheDocument();
    expect(row('登录身份').getByText('ada@example.test')).toBeInTheDocument();
    expect(row('绑定时间').getByText('2026-09-30')).toBeInTheDocument();
    expect(row('License').getByText('valid')).toBeInTheDocument();
    expect(screen.queryByTestId('connection-slot')).toBeNull();
    expect(screen.queryByText('· 离线')).toBeNull();
  });

  it('hands the brand slot the binding, the configuration and the medium size, above the details', () => {
    const snapshot = config('valid');
    show({ kind: 'enterprise', binding, config: snapshot });
    expect(brandSlot.props.at(-1)).toEqual({ slot: 'brandSlot', binding, config: snapshot, size: 'md' });
    const slot = screen.getByTestId('brand-slot');
    const details = screen.getByText('实例').closest('dl')!;
    expect(slot.parentElement).toBe(details.parentElement);
    expect(slot.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts no token or key on the page', () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    const page = everythingOnThePage();
    for (const secret of SECRETS) expect(page).not.toContain(secret);
  });

  it('marks an offline binding and shows the last configuration it had', () => {
    const snapshot = config('expired');
    show({ kind: 'offline', binding, lastConfig: snapshot, reason: 'network' });
    expect(screen.getByText('· 离线')).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(brandSlot.props.at(-1)).toEqual({ slot: 'brandSlot', binding, config: snapshot, size: 'md' });
  });

  it('leaves the licence row out while no configuration has arrived', () => {
    show({ kind: 'enterprise', binding, config: null });
    expect(screen.queryByText('License')).toBeNull();
  });

  it('asks in the app before unbinding, and keeps the binding when the user cancels', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    const question = await unbindQuestion();
    expect(unbind).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: '取消' }));
    await settled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(unbind).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('keeps the binding when the question is closed with Escape', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    await unbindQuestion();
    await userEvent.keyboard('{Escape}');
    await settled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(unbind).not.toHaveBeenCalled();
  });

  it('unbinds once when the user confirms', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    const question = await unbindQuestion();
    const confirmButton = within(question).getByRole('button', { name: '解绑企业实例' });
    expect(confirmButton).toHaveClass('text-danger');
    fireEvent.click(confirmButton);
    await settled();
    expect(unbind).toHaveBeenCalledExactlyOnceWith();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('does nothing when the binding has gone by the time the user confirms', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    const question = await unbindQuestion();
    act(() => { useEnterpriseStore.setState({ mode: { kind: 'personal' } }); });
    fireEvent.click(within(question).getByRole('button', { name: '解绑企业实例' }));
    await settled();
    expect(unbind).not.toHaveBeenCalled();
  });

  it('names the instance the question is about', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    expect(await unbindQuestion()).toHaveAccessibleDescription('https://abu.example.test');
    const page = everythingOnThePage();
    for (const secret of SECRETS) expect(page).not.toContain(secret);
  });

  it('does nothing when another instance is bound by the time the user confirms', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    const question = await unbindQuestion();
    act(() => {
      useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding: { ...binding, serverUrl: 'https://other.example.test' }, config: config('valid') } });
    });
    fireEvent.click(within(question).getByRole('button', { name: '解绑企业实例' }));
    await settled();
    expect(unbind).not.toHaveBeenCalled();
  });

  it('still unbinds the instance that was asked about once it has gone offline', async () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    fireEvent.click(unbindButton());
    const question = await unbindQuestion();
    act(() => {
      useEnterpriseStore.setState({ mode: { kind: 'offline', binding, lastConfig: config('valid'), reason: 'network' } });
    });
    fireEvent.click(within(question).getByRole('button', { name: '解绑企业实例' }));
    await settled();
    expect(unbind).toHaveBeenCalledExactlyOnceWith();
  });

  it('shows the offline mark as a warning tag under the title row, and the licence state with a shape', () => {
    show({ kind: 'offline', binding, lastConfig: config('expired'), reason: 'network' });
    const mark = screen.getByText('· 离线');
    expect(mark).toHaveClass('bg-warning-soft');
    expect(screen.getByRole('heading', { name: '企业模式' })).not.toContainElement(mark);
    const licence = screen.getByText('expired');
    expect(licence).toHaveClass('text-warning');
    expect(licence.querySelector('svg')).not.toBeNull();
  });

  it('shows a valid licence in the success colour with a check', () => {
    show({ kind: 'enterprise', binding, config: config('valid') });
    const licence = screen.getByText('valid');
    expect(licence).toHaveClass('text-success');
    expect(licence).not.toHaveClass('text-warning');
    expect(licence.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('https://abu.example.test')).toHaveClass('font-code');
  });
});
