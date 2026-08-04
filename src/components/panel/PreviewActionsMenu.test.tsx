import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import PreviewActionsMenu from './PreviewActionsMenu';

function renderMenu(overrides: Partial<ComponentProps<typeof PreviewActionsMenu>> = {}) {
  const props: ComponentProps<typeof PreviewActionsMenu> = {
    label: 'More actions',
    revealLabel: 'Reveal in folder',
    copyPathLabel: 'Copy path',
    saveAsLabel: 'Save as',
    onReveal: vi.fn(),
    onCopyPath: vi.fn(),
    onSaveAs: vi.fn(),
    ...overrides,
  };
  render(<PreviewActionsMenu {...props} />);
  return props;
}

describe('PreviewActionsMenu', () => {
  it('keeps filesystem actions collapsed until requested', async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('runs an action and closes the menu', async () => {
    const user = userEvent.setup();
    const onCopyPath = vi.fn();
    renderMenu({ onCopyPath });

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy path/ }));

    expect(onCopyPath).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dismisses on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
