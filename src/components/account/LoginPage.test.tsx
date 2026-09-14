// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import LoginPage from './LoginPage';

describe('LoginPage', () => {
  beforeEach(() => initLanguage('zh-CN'));

  it('shows the personal entry and local-use explanation in an OSS build', () => {
    render(
      <LoginPage
        status="signed_out"
        error={null}
        hasAccount={false}
        onPersonalLogin={() => {}}
        onEnterpriseLogin={() => {}}
        onCancel={() => {}}
        onSignOut={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '个人账号登录' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '企业账号登录' })).toBeNull();
    expect(screen.getByText('不登录也能继续使用本地模型和自己的 API Key')).toBeInTheDocument();
  });

  it('renders a cancellable waiting state without login choices', () => {
    const onCancel = vi.fn();
    render(
      <LoginPage
        status="awaiting_browser"
        error={null}
        hasAccount={false}
        onPersonalLogin={() => {}}
        onEnterpriseLogin={() => {}}
        onCancel={onCancel}
        onSignOut={() => {}}
      />,
    );

    expect(screen.getByText('请在浏览器中完成登录')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '个人账号登录' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['cancelled', '已取消登录。'],
    ['timeout', '登录等待已超时，请重新登录。'],
    ['network_error', '暂时无法连接账号服务，请稍后重试。'],
    ['protocol_not_registered', '当前阿布无法接收登录返回，请检查后重试。'],
  ])('shows a safe failure message for %s while keeping retry available', (error, copy) => {
    render(
      <LoginPage
        status="signed_out"
        error={error}
        hasAccount={false}
        onPersonalLogin={() => {}}
        onEnterpriseLogin={() => {}}
        onCancel={() => {}}
        onSignOut={() => {}}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(copy);
    expect(screen.getByRole('button', { name: '个人账号登录' })).toBeInTheDocument();
  });

  it('offers retry and sign-out for an expired stored session', () => {
    const onSignOut = vi.fn();
    render(
      <LoginPage
        status="expired"
        error="session_expired"
        hasAccount
        onPersonalLogin={() => {}}
        onEnterpriseLogin={() => {}}
        onCancel={() => {}}
        onSignOut={onSignOut}
      />,
    );

    expect(screen.getByText('登录已过期，请重新登录。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新登录' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
