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
