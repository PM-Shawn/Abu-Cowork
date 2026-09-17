// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import type { ProviderInstance } from '@/types/provider';
import ProviderCard from './ProviderCard';

const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  refreshManagedProvider: (...args: unknown[]) => mockRefresh(...args),
}));

function managed(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'org-models',
    source: 'managed',
    name: 'MAZG',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://abu.example.net/api/gateway',
    apiKey: 'sk-virtual',
    models: [
      { id: 'deepseek-v3', label: 'deepseek-v3' },
      { id: 'qwen-max', label: 'qwen-max' },
    ],
    status: 'verified',
    sortOrder: Number.MAX_SAFE_INTEGER,
    userAdded: false,
    ...overrides,
  };
}

function renderCard(provider: ProviderInstance): void {
  render(<ProviderCard provider={provider} isActive={false} onEdit={vi.fn()} />);
}

describe('ProviderCard for a managed provider', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mockRefresh.mockClear();
  });
  afterEach(cleanup);

  it('shows who provides it and how many models are available', () => {
    renderCard(managed());

    expect(screen.getByText('MAZG')).toBeInTheDocument();
    expect(screen.getByText('由 MAZG 提供')).toBeInTheDocument();
    expect(screen.getByText('已连接 · 2 个模型')).toBeInTheDocument();
  });

  it('offers no switch, no edit and no delete', () => {
    renderCard(managed());

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('编辑')).not.toBeInTheDocument();
    expect(screen.queryByTitle('删除')).not.toBeInTheDocument();
    expect(screen.queryByTitle('重新验证')).not.toBeInTheDocument();
  });

  it('never renders the credential or the endpoint', () => {
    renderCard(managed());

    expect(document.body.textContent).not.toContain('sk-virtual');
    expect(document.body.textContent).not.toContain('abu.example.net');
  });

  it('asks the owning system for a fresh list when 重新同步 is clicked', async () => {
    renderCard(managed());

    await userEvent.click(screen.getByTitle('重新同步'));

    expect(mockRefresh).toHaveBeenCalledWith('org-models');
  });

  it.each([
    ['checking', [{ id: 'm', label: 'm' }], '同步中'],
    ['unchecked', [], '同步中'],
    ['failed', [{ id: 'm', label: 'm' }], '离线'],
    ['verified', [], '暂无可用模型，请联系管理员'],
  ] as const)('reads status %s as "%s"', (status, models, text) => {
    renderCard(managed({ status, models: [...models] }));

    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
