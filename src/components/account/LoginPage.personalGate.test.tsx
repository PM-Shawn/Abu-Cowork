// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import LoginPage from './LoginPage';

// 这一版发出去的状态：个人登录关闭，企业构建里只剩企业登录。
vi.mock('@/config/featureGates', () => ({
  IS_ENTERPRISE_BUILD: true,
  IS_PERSONAL_ACCOUNT_ENABLED: false,
}));

const noop = () => {};

describe('LoginPage 个人登录关闭时', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  it('只给企业登录一个入口', () => {
    render(
      <LoginPage
        status="signed_out"
        error={null}
        hasAccount={false}
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '个人账号登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '企业账号登录' })).toBeInTheDocument();
  });

  it('仍然说明不登录也能用', () => {
    render(
      <LoginPage
        status="signed_out"
        error={null}
        hasAccount={false}
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByText('不登录也能继续使用本地模型和自己的 API Key')).toBeInTheDocument();
  });

  it('登录过期时也不出现个人登录按钮', () => {
    render(
      <LoginPage
        status="expired"
        error="session_expired"
        hasAccount
        onPersonalLogin={noop}
        onEnterpriseLogin={noop}
        onCancel={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: '重新登录' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '企业账号登录' })).toBeInTheDocument();
  });
});
