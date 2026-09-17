// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';

const startSidecar = vi.fn().mockResolvedValue(undefined);
const getSidecarStatus = vi.fn(() => 'running' as const);
vi.mock('@/core/sidecar/sidecarManager', () => ({
  getSidecarStatus: () => getSidecarStatus(),
  onSidecarStatusChange: () => () => {},
  startSidecar: () => startSidecar(),
}));

import { useSidecarStatusStore } from '@/stores/sidecarStatusStore';
import SidecarStatusStrip from './SidecarStatusStrip';

describe('SidecarStatusStrip', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    startSidecar.mockClear();
    getSidecarStatus.mockClear();
    useSidecarStatusStore.setState({ status: 'running', waiting: {} });
  });
  afterEach(cleanup);

  it('renders nothing while healthy', () => {
    const { container } = render(<SidecarStatusStrip conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows 正在启动… only for a conversation that is waiting', () => {
    useSidecarStatusStore.setState({ status: 'starting', waiting: { c1: 1 } });
    render(<SidecarStatusStrip conversationId="c1" />);
    expect(screen.getByText('正在启动…')).toBeInTheDocument();
    cleanup();
    render(<SidecarStatusStrip conversationId="c2" />);
    expect(screen.queryByText('正在启动…')).not.toBeInTheDocument();
  });

  it('shows 连接中断，正在恢复… while the sidecar restarts', () => {
    useSidecarStatusStore.setState({ status: 'restarting', waiting: {} });
    render(<SidecarStatusStrip conversationId="c1" />);
    expect(screen.getByText('连接中断，正在恢复…')).toBeInTheDocument();
  });

  it('shows the stopped state with a reconnect action', () => {
    useSidecarStatusStore.setState({ status: 'failed', waiting: {} });
    render(<SidecarStatusStrip conversationId="c1" />);
    expect(screen.getByText('后台服务已停止')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    expect(startSidecar).toHaveBeenCalledTimes(1);
  });

  it('attaches the supervisor projection on mount so it never shows the stale seed', async () => {
    // The store is seeded 'stopped' and only mirrors the supervisor once
    // ensureSidecarStatusProjection() runs — without that call on mount the
    // strip would claim 「后台服务已停止」 on a perfectly healthy launch.
    // Fresh module registry so projectionAttached starts false again.
    vi.resetModules();
    const { default: FreshStrip } = await import('./SidecarStatusStrip');
    const { useSidecarStatusStore: freshStore } = await import('@/stores/sidecarStatusStore');

    expect(freshStore.getState().status).toBe('stopped');
    render(<FreshStrip conversationId="c1" />);

    expect(getSidecarStatus).toHaveBeenCalled();
    expect(freshStore.getState().status).toBe('running');
    expect(screen.queryByText('后台服务已停止')).not.toBeInTheDocument();
  });
});
