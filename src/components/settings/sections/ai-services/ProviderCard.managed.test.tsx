// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
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

function renderCard(provider: ProviderInstance, isActive = false): void {
  render(<ProviderCard provider={provider} isActive={isActive} onEdit={vi.fn()} />, { wrapper: DesignSystemProvider });
}

const card = () => screen.getByText('MAZG').closest<HTMLElement>('div.group')!;

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
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新验证' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('never renders the credential or the endpoint', () => {
    renderCard(managed());

    expect(document.body.innerHTML).toContain('MAZG');
    expect(document.body.innerHTML).not.toContain('sk-virtual');
    expect(document.body.innerHTML).not.toContain('abu.example.net');
  });

  it('asks the owning system for a fresh list when 重新同步 is clicked', async () => {
    renderCard(managed());

    await userEvent.click(screen.getByRole('button', { name: '重新同步' }));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith('org-models');
  });

  it('shows one spinner while syncing, keeps the button icon still and switches the button off', () => {
    renderCard(managed({ status: 'checking' }));

    expect(card().querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('同步中');
    const resync = screen.getByRole('button', { name: '重新同步' });
    expect(resync).toBeDisabled();
    expect(resync.querySelector('[data-ds-spinner]')).toBeNull();
    expect(resync.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps the button usable before the first sync has started', () => {
    renderCard(managed({ status: 'unchecked', models: [] }));

    expect(screen.getByRole('button', { name: '重新同步' })).toBeEnabled();
  });

  it('marks offline with a shape as well as a colour, and spins nothing', () => {
    renderCard(managed({ status: 'failed' }));

    const offline = screen.getByText('离线');
    expect(offline).toHaveClass('text-warning');
    expect(offline.querySelector('svg')).not.toBeNull();
    expect(card().querySelector('[data-ds-spinner]')).toBeNull();
  });

  it('lists every model in the hover text of the summary', () => {
    renderCard(managed({ models: [{ id: 'a', label: 'A' }, { id: 'b', label: '' }, { id: 'c', label: 'C' }] }));

    expect(screen.getByText('A, b +1')).toHaveAttribute('title', 'A\nb\nC');
  });

  it('marks the provider in use with the selected fill', () => {
    renderCard(managed(), true);
    expect(card()).toHaveClass('bg-fill-selected');
    cleanup();

    renderCard(managed());
    expect(card()).not.toHaveClass('bg-fill-selected');
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
