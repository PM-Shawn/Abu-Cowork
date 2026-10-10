// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as renderBare, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import FolderSelector from './FolderSelector';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const RECENT = ['/Users/demo/alpha', '/Users/demo/beta'];

describe('FolderSelector', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    vi.mocked(openDialog).mockReset();
  });

  afterEach(cleanup);

  it('opens the folder dialog directly the first time, with nothing to list', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue('/Users/demo/picked');
    const onSelect = vi.fn();
    render(<FolderSelector currentPath={null} recentPaths={[]} onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: getI18n().folder.loadFolder }));

    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('/Users/demo/picked');
  });

  it('lists recent folders with the current one checked, and picks another', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FolderSelector currentPath={RECENT[0]} recentPaths={RECENT} onSelect={onSelect} appearance="context-bar" />);

    await user.click(screen.getByRole('button', { name: 'alpha' }));

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /alpha/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /beta/ })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('menuitemradio', { name: /beta/ }));

    expect(onSelect).toHaveBeenCalledWith('/Users/demo/beta');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the folder dialog from the menu', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(null);
    render(<FolderSelector currentPath={RECENT[0]} recentPaths={RECENT} onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'alpha' }));
    await user.click(await screen.findByRole('menuitem', { name: getI18n().folder.selectOtherFolder }));

    expect(openDialog).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and puts focus back on the folder button', async () => {
    const user = userEvent.setup();
    render(<FolderSelector currentPath={RECENT[0]} recentPaths={RECENT} onSelect={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'alpha' });
    await user.click(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('clears the folder from a named button', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<FolderSelector currentPath={RECENT[0]} recentPaths={RECENT} onSelect={vi.fn()} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: getI18n().folder.clearWorkspace }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('marks a chosen folder on the chip with the selected fill', () => {
    render(<FolderSelector currentPath={RECENT[0]} recentPaths={RECENT} onSelect={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'alpha' })).toHaveClass('bg-fill-selected');
  });
});
