// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';

function Host({ staysOnOutsidePress, keepFocus = false, onCloseAutoFocus }: {
  staysOnOutsidePress?: boolean;
  keepFocus?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DesignSystemProvider>
      <input aria-label="Draft" />
      <Menu trigger={<Button>Other</Button>}><MenuItem>Rename</MenuItem></Menu>
      <Popover
        open={open}
        onOpenChange={setOpen}
        staysOnOutsidePress={staysOnOutsidePress}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (keepFocus) event.preventDefault();
        }}
        trigger={<Button>Details</Button>}
      >
        <button
          type="button"
          onClick={() => {
            if (keepFocus) screen.getByRole('textbox', { name: 'Draft' }).focus();
            setOpen(false);
          }}
        >
          Use it
        </button>
      </Popover>
    </DesignSystemProvider>
  );
}

describe('Popover', () => {
  it('closes on a press outside by default', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Use it' })).toBeInTheDocument();
    await user.click(screen.getByRole('textbox', { name: 'Draft' }));
    expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull();
  });

  describe('staysOnOutsidePress', () => {
    it('stays open while the user presses and types elsewhere on the page', async () => {
      const user = userEvent.setup();
      render(<Host staysOnOutsidePress />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('textbox', { name: 'Draft' }));
      await user.keyboard('abc');
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('abc');
      expect(screen.getByRole('button', { name: 'Use it' })).toBeInTheDocument();
    });

    it('still closes when another layer opens', async () => {
      const user = userEvent.setup();
      render(<Host staysOnOutsidePress />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('button', { name: 'Other' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull();
    });

    it('still closes on Escape', async () => {
      const user = userEvent.setup();
      render(<Host staysOnOutsidePress />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      expect(screen.getByRole('button', { name: 'Use it' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull();
    });

    it('still closes from its own button', async () => {
      const user = userEvent.setup();
      render(<Host staysOnOutsidePress />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('button', { name: 'Use it' }));
      expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull();
    });
  });

  describe('its own box', () => {
    it('carries the data attributes and the name it is given', async () => {
      const user = userEvent.setup();
      render(
        <DesignSystemProvider>
          <Popover trigger={<Button>Avatar</Button>} contentProps={{ 'data-testid': 'x' }} label="Choose an avatar">
            <Button>Blue</Button>
          </Popover>
        </DesignSystemProvider>,
      );
      expect(screen.queryByTestId('x')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Avatar' }));
      const box = screen.getByTestId('x');
      expect(box).toHaveAttribute('role', 'dialog');
      expect(box).toHaveAttribute('aria-label', 'Choose an avatar');
      expect(box).toHaveAttribute('data-ds-layer');
      expect(screen.getByRole('dialog', { name: 'Choose an avatar' })).toBe(box);
    });

    it('has no name of its own when none is given', async () => {
      const user = userEvent.setup();
      render(<Host />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-label');
    });

    // The popover never grows past the room between its trigger and the window edge; more scrolls inside it.
    it('scrolls inside the room it has', async () => {
      const user = userEvent.setup();
      render(<Host />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      const classes = (screen.getByRole('dialog').getAttribute('class') ?? '').split(/\s+/);
      expect(classes).toContain('overflow-y-auto');
      expect(classes).toContain('max-h-(--radix-popover-content-available-height)');
    });
  });

  describe('onOpenAutoFocus', () => {
    function Card({ takeFocus }: { takeFocus: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <DesignSystemProvider>
          <Button onClick={() => setOpen(true)}>Show later</Button>
          <Popover
            open={open}
            onOpenChange={setOpen}
            staysOnOutsidePress
            onOpenAutoFocus={(event) => { if (!takeFocus) event.preventDefault(); }}
            trigger={<Button>Details</Button>}
          >
            <Button>Use it</Button>
          </Popover>
        </DesignSystemProvider>
      );
    }

    it('moves the focus into the popover when the caller does nothing', async () => {
      const user = userEvent.setup();
      render(<Card takeFocus />);
      await user.click(screen.getByRole('button', { name: 'Show later' }));
      await vi.waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    });

    it('keeps the focus on the control that opened it when the caller prevents the default', async () => {
      const user = userEvent.setup();
      render(<Card takeFocus={false} />);
      const opener = screen.getByRole('button', { name: 'Show later' });
      await user.click(opener);
      expect(screen.getByRole('button', { name: 'Use it' })).toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(screen.getByRole('dialog')).not.toContainElement(document.activeElement as HTMLElement);
    });
  });

  describe('onCloseAutoFocus', () => {
    it('returns the focus to the trigger when the caller does nothing', async () => {
      const user = userEvent.setup();
      const onCloseAutoFocus = vi.fn();
      render(<Host onCloseAutoFocus={onCloseAutoFocus} />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('button', { name: 'Use it' }));
      await vi.waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Details' })).toHaveFocus();
    });

    it('leaves the focus where the caller put it when the caller prevents the default', async () => {
      const user = userEvent.setup();
      const onCloseAutoFocus = vi.fn();
      render(<Host keepFocus onCloseAutoFocus={onCloseAutoFocus} />);
      await user.click(screen.getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('button', { name: 'Use it' }));
      await vi.waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
    });
  });
});
