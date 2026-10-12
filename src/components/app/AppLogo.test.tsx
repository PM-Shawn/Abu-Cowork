// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSettingsStore } from '@/stores/settingsStore';
import { redactFailureText } from '@/core/diagnostic/scrub';
import AppLogo from './AppLogo';

vi.mock('@/utils/pathUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/pathUtils')>()),
  loadLocalImage: async (filePath: string) => {
    if (filePath.includes('/removed/')) throw new Error(`ENOENT: no such file or directory, open '${filePath}?token=abc123secret'`);
    return `blob:${filePath}`;
  },
}));

describe('AppLogo', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
    useSettingsStore.setState({ theme: useSettingsStore.getInitialState().theme });
  });

  describe('the image variant follows the appearance on the page', () => {
    const image = () => screen.getByTestId('app-logo').querySelector('img');

    it('shows the dark variant while <html> is dark, whatever the stored setting says', async () => {
      useSettingsStore.setState({ theme: 'light' });
      document.documentElement.classList.add('dark');
      render(<AppLogo name="Shop desk" logo="/pkg/light.png" logoDark="/pkg/dark.png" />);
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/dark.png'));
    });

    it('shows the light variant while <html> is light, whatever the stored setting says', async () => {
      useSettingsStore.setState({ theme: 'dark' });
      render(<AppLogo name="Shop desk" logo="/pkg/light.png" logoDark="/pkg/dark.png" />);
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/light.png'));
    });

    it('changes variant when the appearance changes while it is on the page', async () => {
      render(<AppLogo name="Shop desk" logo="/pkg/light.png" logoDark="/pkg/dark.png" />);
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/light.png'));
      await act(async () => { document.documentElement.classList.add('dark'); });
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/dark.png'));
      await act(async () => { document.documentElement.classList.remove('dark'); });
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/light.png'));
    });

    it('uses the only variant a package ships in either appearance', async () => {
      document.documentElement.classList.add('dark');
      render(<AppLogo name="Shop desk" logo="/pkg/light.png" />);
      await waitFor(() => expect(image()).toHaveAttribute('src', 'blob:/pkg/light.png'));
    });
  });

  it('shows the first letter of the name, hidden from screen readers, when the package ships no image', () => {
    render(<AppLogo name="  Shop desk" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveAttribute('data-app-logo', 'letter');
    expect(logo).toHaveAttribute('aria-hidden', 'true');
    expect(logo).toHaveTextContent('S');
  });

  describe('an image that cannot be shown', () => {
    const logo = () => screen.getByTestId('app-logo');

    it('shows the letter mark when the file is gone, and sends the reason to the console only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<AppLogo name="Shop desk" logo="/apps/removed/logo.png" />);
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      const reason = redactFailureText("ENOENT: no such file or directory, open '/apps/removed/logo.png?token=abc123secret'");
      expect(reason).not.toContain('abc123secret');
      expect(warn).toHaveBeenCalledWith('[app] logo image failed:', reason);
      expect(logo()).toHaveAttribute('data-app-logo', 'letter');
      expect(logo()).toHaveTextContent('S');
      expect(logo().outerHTML).not.toContain('ENOENT');
      warn.mockRestore();
    });

    it('replaces the image it showed with the letter mark when the next file is gone', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { rerender } = render(<AppLogo name="Shop desk" logo="/pkg/light.png" />);
      await waitFor(() => expect(logo()).toHaveAttribute('data-app-logo', 'image'));
      rerender(<AppLogo name="Shop desk" logo="/apps/removed/logo.png" />);
      await waitFor(() => expect(logo()).toHaveAttribute('data-app-logo', 'letter'));
      warn.mockRestore();
    });

    it('shows the letter mark when the file is no picture the page can draw', async () => {
      render(<AppLogo name="Shop desk" logo="/pkg/light.png" />);
      await waitFor(() => expect(logo()).toHaveAttribute('data-app-logo', 'image'));
      fireEvent.error(logo().querySelector('img')!);
      expect(logo()).toHaveAttribute('data-app-logo', 'letter');
    });
  });

  it('draws the letter mark with design-system classes', () => {
    render(<AppLogo name="Shop desk" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveClass('rounded-control');
    expect(logo).toHaveClass('bg-fill');
    expect(logo).toHaveClass('text-label');
    expect(logo).toHaveClass('font-medium');
  });

  it.each([
    ['sm', 'h-5', 'text-caption'],
    ['md', 'h-7', 'text-ui-sm'],
    ['lg', 'h-10', 'text-title'],
    ['xl', 'h-20', 'text-title-lg'],
  ] as const)('size %s is %s with %s letters', (size, box, text) => {
    render(<AppLogo name="Shop desk" size={size} />);
    expect(screen.getByTestId('app-logo')).toHaveClass(box);
    expect(screen.getByTestId('app-logo')).toHaveClass(text);
  });

  it('lets the caller change the corner and the size', () => {
    render(<AppLogo name="Shop desk" size="sm" className="h-4 w-4 rounded-window" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveClass('rounded-window');
    expect(logo).not.toHaveClass('rounded-control');
    expect(logo).toHaveClass('h-4');
    expect(logo).not.toHaveClass('h-5');
  });

  it('shows the avatar of Abu for the general shell', () => {
    render(<AppLogo name="Abu" general />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toHaveAttribute('data-app-logo', 'general');
    expect(logo.querySelector('img')).not.toBeNull();
  });
});
