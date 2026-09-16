// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { AUTHOR_LINKS } from '@/utils/authorLinks';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';
import AuthorSection from './AuthorSection';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

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
    render(<AuthorSection />);

    expect(screen.getByRole('heading', { name: '关于作者' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shawn' })).toBeInTheDocument();
    expect(screen.getByText(/爱折腾、理性、去噪、极客精神、深度实践/)).toBeInTheDocument();
    expect(screen.getByText(/月消耗 Token 300 亿/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '关注公众号' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '请作者喝杯咖啡' })).toBeInTheDocument();
  });

  it('opens each social profile at its configured address', async () => {
    render(<AuthorSection />);

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
    render(<AuthorSection />);

    await userEvent.click(screen.getByRole('button', { name: /myabu\.cn/ }));

    expect(openUrl).toHaveBeenCalledWith(OFFICIAL_WEBSITE_URL);
  });

  it('enlarges a QR code on click and closes on Escape', async () => {
    render(<AuthorSection />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /请作者喝杯咖啡/ }));

    const dialog = screen.getByRole('dialog', { name: '请作者喝杯咖啡' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent('如果觉得阿布好用，请作者喝杯咖啡吧');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('swallows the Escape that closes the zoom so the settings dialog underneath stays open', async () => {
    // SystemSettingsDialog closes on a bubbling document keydown; the zoom
    // must consume the key before it gets there.
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    render(<AuthorSection />);
    await userEvent.click(screen.getByRole('button', { name: /关注公众号/ }));

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(underneath).not.toHaveBeenCalled();
    document.removeEventListener('keydown', underneath);
  });

  it('closes the enlarged view when the backdrop is clicked, but not the card', async () => {
    render(<AuthorSection />);
    await userEvent.click(screen.getByRole('button', { name: /关注公众号/ }));
    const dialog = screen.getByRole('dialog', { name: '关注公众号' });

    // Inside the card (the enlarged image) — the click must not fall through.
    await userEvent.click(within(dialog).getByRole('img', { name: '关注公众号' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the disclaimer here now that the version page no longer carries it', async () => {
    render(<AuthorSection />);
    expect(screen.queryByText('收起')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '免责声明' }));

    expect(screen.getByText('收起')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /免责声明（完整版）/ }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('DISCLAIMER.zh-CN.md'));
  });
});
