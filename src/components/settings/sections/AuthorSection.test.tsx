// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { AUTHOR_LINKS } from '@/utils/authorLinks';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import AuthorSection from './AuthorSection';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

function renderPage() {
  return render(<AuthorSection />, { wrapper: DesignSystemProvider });
}

describe('AuthorSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
    openUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('introduces the author and both ways to reach or support them', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: '关于作者' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shawn' })).toBeInTheDocument();
    expect(screen.getByText(/爱折腾、理性、去噪、极客精神、深度实践/)).toBeInTheDocument();
    expect(screen.getByText(/月消耗 Token 300 亿/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '关注公众号' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '请作者喝杯咖啡' })).toBeInTheDocument();
  });

  it('opens each social profile at its configured address', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /小红书/ }));
    await userEvent.click(screen.getByRole('button', { name: /^X$/ }));
    await userEvent.click(screen.getByRole('button', { name: /GitHub/ }));

    expect(openUrl.mock.calls.map((c) => c[0])).toEqual([
      AUTHOR_LINKS.xiaohongshu,
      AUTHOR_LINKS.x,
      AUTHOR_LINKS.github,
    ]);
  });

  it('links the product website from the footer', async () => {
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /myabu\.cn/ }));

    expect(openUrl).toHaveBeenCalledWith(OFFICIAL_WEBSITE_URL);
  });

  it('enlarges a QR code on click and closes on Escape', async () => {
    renderPage();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /请作者喝杯咖啡/ }));

    const dialog = screen.getByRole('dialog', { name: '请作者喝杯咖啡' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('如果觉得阿布好用，请作者喝杯咖啡吧');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes only the enlarged view on Escape: the settings window underneath stays open', async () => {
    const onSettingsChange = vi.fn();
    render(
      <Dialog open onOpenChange={onSettingsChange} title="Settings" titleHidden size="page">
        <AuthorSection />
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await userEvent.click(screen.getByRole('button', { name: /关注公众号/ }));
    expect(screen.getByRole('dialog', { name: '关注公众号' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: '关注公众号' })).not.toBeInTheDocument();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shawn' })).toBeInTheDocument();
  });

  it('closes the enlarged view on a press outside it, but not on a press on the code', async () => {
    // The page behind an open dialog takes no pointer input; the press still reaches the scrim.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPage();
    await user.click(screen.getByRole('button', { name: /关注公众号/ }));
    const dialog = screen.getByRole('dialog', { name: '关注公众号' });

    // Inside the dialog (the enlarged image) — the press must not close it.
    await user.click(within(dialog).getByRole('img', { name: '关注公众号' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const scrim = document.querySelector('.bg-scrim');
    if (!scrim) throw new Error('No scrim');
    await user.click(scrim);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the enlarged code on a white ground, named for screen readers without a visible heading', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /请作者喝杯咖啡/ }));
    const dialog = screen.getByRole('dialog', { name: '请作者喝杯咖啡' });

    const code = within(dialog).getByRole('img', { name: '请作者喝杯咖啡' });
    expect(code.parentElement).toHaveClass('bg-page-canvas');
    expect(within(dialog).queryByRole('heading', { name: '请作者喝杯咖啡' })).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-ds-layer');
    expect(dialog).toHaveAttribute('data-electron-no-drag');
  });

  it('closes the enlarged view from its close button', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /关注公众号/ }));
    const dialog = screen.getByRole('dialog', { name: '关注公众号' });

    await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the disclaimer here now that the version page no longer carries it', async () => {
    renderPage();
    expect(screen.queryByText('收起')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '免责声明' }));

    expect(screen.getByText('收起')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /免责声明（完整版）/ }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('DISCLAIMER.zh-CN.md'));
  });
});
