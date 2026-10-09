// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { formatBundleSize } from '@/core/diagnostic/bundle';
import { initLanguage } from '@/i18n';
import ExportSuccessCard from './ExportSuccessCard';

const revealItemInDir = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (...a: unknown[]) => revealItemInDir(...a),
}));

// A made-up export: nothing here is read from or written to a disk.
const BUNDLE = {
  path: '/made-up/Downloads/Abu-Diagnostic/abu-diagnostic-c1-20261002-120000.zip',
  sizeBytes: 20480,
  scrubbedTextCount: 3,
  fileList: ['conversations/c1.json', 'diagnostic-snapshot.json', 'manifest.json'],
};

function renderCard(onDismiss = vi.fn()) {
  render(<ExportSuccessCard {...BUNDLE} onDismiss={onDismiss} />, { wrapper: DesignSystemProvider });
  return onDismiss;
}

describe('ExportSuccessCard', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    revealItemInDir.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it('names the file and says how large it is and how much was redacted', () => {
    renderCard();

    expect(screen.getByText('已导出诊断包')).toBeInTheDocument();
    expect(screen.getByText('abu-diagnostic-c1-20261002-120000.zip')).toBeInTheDocument();
    expect(screen.getByText(`${formatBundleSize(BUNDLE.sizeBytes)} · 3 个文件 · 已脱敏 3 处`)).toBeInTheDocument();
  });

  it('shows the bundle in the file manager', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: '在 Finder 中显示' }));

    expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith(BUNDLE.path);
  });

  it('copies the full path and says it did', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderCard();

    await user.click(screen.getByRole('button', { name: '复制路径' }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(BUNDLE.path);
    expect(await screen.findByRole('button', { name: '路径已复制' })).toBeInTheDocument();
  });

  it('lists what is in the bundle, and closes the list again', async () => {
    const user = userEvent.setup();
    renderCard();
    expect(screen.queryByText('manifest.json')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看包内清单' }));

    expect(screen.getByText('诊断包内容')).toBeInTheDocument();
    for (const file of BUNDLE.fileList) expect(screen.getByText(file)).toBeInTheDocument();

    // The list has its own close buttons; the last button named 关闭 on the page belongs to it.
    const closeButtons = screen.getAllByRole('button', { name: '关闭' });
    await user.click(closeButtons[closeButtons.length - 1]);

    await waitFor(() => expect(screen.queryByText('manifest.json')).not.toBeInTheDocument());
    expect(screen.getByText('已导出诊断包')).toBeInTheDocument();
  });

  it('opens the list as a dialog over the settings window, and Escape closes only the list', async () => {
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    render(
      <Dialog open onOpenChange={onSettingsChange} title="Settings" titleHidden size="page">
        <ExportSuccessCard {...BUNDLE} onDismiss={vi.fn()} />
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );

    await user.click(screen.getByRole('button', { name: '查看包内清单' }));

    const list = screen.getByRole('dialog', { name: '诊断包内容' });
    for (const file of BUNDLE.fileList) expect(within(list).getByText(file)).toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: '关闭' })).toHaveLength(2);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '诊断包内容' })).not.toBeInTheDocument());
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('已导出诊断包')).toBeInTheDocument();
  });

  it('tells the page when the card is dismissed', async () => {
    const user = userEvent.setup();
    const onDismiss = renderCard();

    await user.click(screen.getByRole('button', { name: '关闭' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
