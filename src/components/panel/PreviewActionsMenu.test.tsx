// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import PreviewActionsMenu from './PreviewActionsMenu';

function renderMenu(overrides: Partial<ComponentProps<typeof PreviewActionsMenu>> = {}) {
  const props: ComponentProps<typeof PreviewActionsMenu> = {
    label: 'More actions',
    revealLabel: 'Reveal in folder',
    copyPathLabel: 'Copy path',
    saveAsLabel: 'Save as…',
    onReveal: vi.fn(),
    onCopyPath: vi.fn(),
    onSaveAs: vi.fn(),
    ...overrides,
  };
  render(
    <DesignSystemProvider>
      <PreviewActionsMenu {...props} />
    </DesignSystemProvider>,
  );
  return props;
}

describe('PreviewActionsMenu', () => {
  // happy-dom lacks the pointer-capture and scroll methods Radix menus call.
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  it('keeps filesystem actions collapsed until requested', async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));

    // The menu is a floating layer: it must not sit in the window's drag lane.
    expect(screen.getByRole('menu')).toHaveAttribute('data-electron-no-drag');
    expect(screen.getByRole('menuitem', { name: 'Reveal in folder' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save as…' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('runs an action and closes the menu', async () => {
    const user = userEvent.setup();
    const onCopyPath = vi.fn();
    renderMenu({ onCopyPath });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Copy path' }));

    expect(onCopyPath).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('saves a copy once and closes the menu', async () => {
    const user = userEvent.setup();
    const onSaveAs = vi.fn();
    const onReveal = vi.fn();
    renderMenu({ onSaveAs, onReveal });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Save as…' }));

    expect(onSaveAs).toHaveBeenCalledOnce();
    expect(onReveal).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('moves the highlight with the arrow keys without running anything', async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');

    expect(screen.getByRole('menuitem', { name: 'Save as…' })).toHaveAttribute('data-highlighted');
    expect(props.onReveal).not.toHaveBeenCalled();
    expect(props.onCopyPath).not.toHaveBeenCalled();
    expect(props.onSaveAs).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('dismisses on Escape and returns focus to the button', async () => {
    const user = userEvent.setup();
    const props = renderMenu();

    const trigger = screen.getByRole('button', { name: 'More actions' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(props.onReveal).not.toHaveBeenCalled();
    expect(props.onCopyPath).not.toHaveBeenCalled();
    expect(props.onSaveAs).not.toHaveBeenCalled();
  });
});
