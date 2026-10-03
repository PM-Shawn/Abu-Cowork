// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import InstalledItemMenu from './InstalledItemMenu';
import ToolDetailModal from './ToolDetailModal';

function renderModal(props: Partial<ComponentProps<typeof ToolDetailModal>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <DesignSystemProvider>
      <ToolDetailModal open ariaLabel="canva" testId="detail" onClose={onClose} {...props}>
        {props.children ?? <p>Body text</p>}
      </ToolDetailModal>
    </DesignSystemProvider>,
  );
  return { onClose, ...view };
}

describe('ToolDetailModal', () => {
  it('renders nothing while closed', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
    expect(screen.queryByText('Body text')).not.toBeInTheDocument();
  });

  it('puts the test id on the window and names the dialog after ariaLabel', () => {
    renderModal({ title: 'Canva plugin' });
    const dialog = screen.getByRole('dialog', { name: 'canva' });
    expect(dialog).toHaveAttribute('data-testid', 'detail');
    expect(dialog).toHaveAttribute('data-ds-layer');
  });

  it('names the dialog after a string title when there is no ariaLabel', () => {
    renderModal({ ariaLabel: undefined, title: 'Canva plugin' });
    expect(screen.getByRole('dialog', { name: 'Canva plugin' })).toBeInTheDocument();
  });

  it('shows the name as plain text: the only heading is the hidden dialog title', () => {
    renderModal({ title: 'Canva plugin' });
    const headings = within(screen.getByRole('dialog')).getAllByRole('heading');
    expect(headings.map((heading) => heading.textContent)).toEqual(['canva']);
    expect(screen.getByText('Canva plugin').tagName).toBe('DIV');
  });

  it('shows the avatar, title, subtitle, header actions, footer and body', () => {
    renderModal({
      avatar: <span>AV</span>,
      title: 'Canva plugin',
      subtitle: 'Design tools',
      headerActions: <Button>Header action</Button>,
      footer: <Button>Footer action</Button>,
    });
    const dialog = screen.getByTestId('detail');
    expect(dialog).toHaveTextContent('AV');
    expect(dialog).toHaveTextContent('Canva plugin');
    expect(dialog).toHaveTextContent('Design tools');
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'Header action' }));
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'Footer action' }));
    expect(dialog).toHaveTextContent('Body text');
  });

  it('keeps the name row and its actions out of the scrolling area', () => {
    renderModal({ title: 'Canva plugin', subtitle: 'Design tools', headerActions: <Button>Header action</Button> });
    const scrolling = screen.getByTestId('detail').querySelector('.overflow-y-auto');
    expect(scrolling).toContainElement(screen.getByText('Body text'));
    expect(scrolling).not.toContainElement(screen.getByText('Canva plugin'));
    expect(scrolling).not.toContainElement(screen.getByText('Design tools'));
    expect(scrolling).not.toContainElement(screen.getByRole('button', { name: 'Header action' }));
  });

  it('with an item menu in the header: Escape closes the menu, the next Escape closes the window', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({
      title: 'Canva plugin',
      headerActions: <InstalledItemMenu ariaLabel="Canva actions" testId="detail-menu" actions={[{ id: 'edit', label: 'Edit', onSelect: vi.fn() }]} />,
    });
    const trigger = screen.getByRole('button', { name: 'Canva actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose from the close button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ title: 'Canva plugin' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape, also when disableEscape is passed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ title: 'Canva plugin', disableEscape: true });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('maps the three widths to dialog sizes and anything else to the middle one', () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'max-w-md'],
      ['max-w-lg', 'max-w-md'],
      ['max-w-2xl', 'max-w-2xl'],
      ['max-w-4xl', 'max-w-3xl'],
      ['max-w-xl', 'max-w-2xl'],
    ];
    for (const [maxWidth, expected] of cases) {
      const { unmount } = renderModal({ maxWidth });
      expect(screen.getByTestId('detail'), String(maxWidth)).toHaveClass(expected);
      unmount();
    }
  });

  it('uses only the height class of panelClassName, on the content area', () => {
    renderModal({ panelClassName: 'h-96 border-4', children: <p>Sized body</p> });
    const area = screen.getByText('Sized body').parentElement;
    expect(area).toHaveClass('h-96');
    expect(area).not.toHaveClass('border-4');
    expect(screen.getByTestId('detail')).not.toHaveClass('h-96');
  });
});
