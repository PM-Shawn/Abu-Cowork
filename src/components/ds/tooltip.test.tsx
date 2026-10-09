// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { Dialog } from './dialog';
import { AppIcons } from './icons';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';
import { TextField } from './text-field';
import { Tooltip } from './tooltip';

describe('Tooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the design-system delay when a faster provider is nearer', () => {
    // A Radix provider of a caller's own (200 ms) inside DesignSystemProvider.
    render(
      <DesignSystemProvider>
        <TooltipPrimitive.Provider delayDuration={200}>
          <Tooltip content="Copy code"><Button>Copy</Button></Tooltip>
        </TooltipPrimitive.Provider>
      </DesignSystemProvider>,
    );
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Copy' }), { pointerType: 'mouse' });

    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole('tooltip').textContent).toBe('Copy code');
  });
});

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

// Capture listeners for keydown that are on the window right now.
function trackWindowKeydownListeners() {
  const live = new Set<EventListenerOrEventListenerObject>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'keydown' && options === true) live.add(listener);
    add(type, listener, options);
  });
  const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === 'keydown' && options === true) live.delete(listener);
    remove(type, listener, options);
  });
  return { count: () => live.size, restore: () => { addSpy.mockRestore(); removeSpy.mockRestore(); } };
}

describe('Tooltip and Escape', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('one Escape closes a dialog that opened on a control with a tooltip, while exit fades stay on the page', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <DesignSystemProvider>
        <Dialog trigger={<Button>Open</Button>} onOpenChange={onOpenChange} title="Detail">
          <IconButton icon={AppIcons.more} label="More" />
        </Dialog>
      </DesignSystemProvider>,
    );
    screen.getByRole('button', { name: 'Open' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
    onOpenChange.mockClear();
    keepClosingLayersOnScreen();

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('menu inside a dialog: Escape closes the menu, the next Escape closes the dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <DesignSystemProvider>
        <Dialog open onOpenChange={onOpenChange} title="Detail">
          <Button>First</Button>
          <Menu trigger={<IconButton icon={AppIcons.more} label="More" />}>
            <MenuItem>Edit</MenuItem>
          </Menu>
        </Dialog>
      </DesignSystemProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    // The name shows again with the keyboard focus.
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More');

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a tooltip shown by hover does not take the Escape pressed in a field of the dialog', () => {
    vi.useFakeTimers();
    try {
      const onOpenChange = vi.fn();
      render(
        <DesignSystemProvider>
          <Dialog open onOpenChange={onOpenChange} title="Detail">
            <TextField aria-label="Name" />
            <IconButton icon={AppIcons.more} label="More" />
          </Dialog>
        </DesignSystemProvider>,
      );
      const field = screen.getByRole('textbox', { name: 'Name' });
      field.focus();
      fireEvent.keyDown(field, { key: 'a' });
      fireEvent.pointerMove(screen.getByRole('button', { name: 'More' }), { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(499); });
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('tooltip')).toHaveTextContent('More');
      expect(field).toHaveFocus();

      fireEvent.keyDown(field, { key: 'Escape' });

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no layer open, Escape hides the tooltip only, and keyboard focus shows it again', async () => {
    const user = userEvent.setup();
    const prevented: boolean[] = [];
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') prevented.push(event.defaultPrevented); };
    window.addEventListener('keydown', onKeyDown);
    render(
      <DesignSystemProvider>
        <IconButton icon={AppIcons.more} label="More" />
        <Button>Next</Button>
      </DesignSystemProvider>,
    );
    const button = screen.getByRole('button', { name: 'More' });
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More');

    await user.keyboard('{Escape}');
    window.removeEventListener('keydown', onKeyDown);

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button).toHaveFocus();
    expect(prevented).toEqual([false]);

    await user.tab();
    await user.tab({ shift: true });
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
  });

  it('listens for keys only while the tooltip is open, also when mounted twice by StrictMode', async () => {
    const user = userEvent.setup();
    const listeners = trackWindowKeydownListeners();
    const view = render(
      <StrictMode>
        <DesignSystemProvider>
          <IconButton icon={AppIcons.more} label="More" />
          <Button>Next</Button>
        </DesignSystemProvider>
      </StrictMode>,
    );
    expect(listeners.count()).toBe(0);
    await user.tab();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(listeners.count()).toBe(1);

    await user.keyboard('{Escape}');
    expect(listeners.count()).toBe(0);

    await user.tab();
    await user.tab({ shift: true });
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(listeners.count()).toBe(1);
    view.unmount();
    expect(listeners.count()).toBe(0);
    listeners.restore();
  });

  // A tooltip that is fading out is still on the page, and Radix still counts it as the top
  // layer for Escape. The key acts on the layer underneath all the same.
  describe('while the tooltip fades out', () => {
    const fadingTooltip = () => document.querySelector<HTMLElement>('.z-tooltip[data-state="closed"]');
    function endFade() {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { fadingTooltip()!.dispatchEvent(ended); });
    }

    it('one Escape closes the dialog under it', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <DesignSystemProvider>
          <Dialog trigger={<Button>Open</Button>} onOpenChange={onOpenChange} title="Detail">
            <IconButton icon={AppIcons.more} label="More" />
            <TextField aria-label="Name" />
          </Dialog>
        </DesignSystemProvider>,
      );
      screen.getByRole('button', { name: 'Open' }).focus();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
      onOpenChange.mockClear();
      keepClosingLayersOnScreen();
      await user.tab();
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
      expect(fadingTooltip()).not.toBeNull();

      await user.keyboard('{Escape}');

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(fadingTooltip()).toBeNull();
    });

    it('one Escape closes the menu that its control opened', async () => {
      const user = userEvent.setup();
      render(
        <DesignSystemProvider>
          <Menu trigger={<IconButton icon={AppIcons.more} label="More" />}>
            <MenuItem>Edit</MenuItem>
          </Menu>
        </DesignSystemProvider>,
      );
      await user.tab();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
      keepClosingLayersOnScreen();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('menu')).toHaveAttribute('data-state', 'open');
      expect(fadingTooltip()).not.toBeNull();

      await user.keyboard('{Escape}');

      expect(screen.getByRole('menu')).toHaveAttribute('data-state', 'closed');
      expect(fadingTooltip()).toBeNull();
    });

    it('one Escape closes the popover that its control opened', async () => {
      const user = userEvent.setup();
      render(
        <DesignSystemProvider>
          <Popover label="Details" trigger={<IconButton icon={AppIcons.more} label="More" />}>
            <Button>Inside</Button>
          </Popover>
        </DesignSystemProvider>,
      );
      await user.tab();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
      keepClosingLayersOnScreen();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name: 'Details' })).toHaveAttribute('data-state', 'open');
      expect(fadingTooltip()).not.toBeNull();

      await user.keyboard('{Escape}');

      expect(document.querySelector('[role="dialog"][aria-label="Details"]')).toHaveAttribute('data-state', 'closed');
      expect(fadingTooltip()).toBeNull();
    });

    it('listens for keys until the fade has ended, and no longer', async () => {
      const user = userEvent.setup();
      const listeners = trackWindowKeydownListeners();
      render(
        <DesignSystemProvider>
          <IconButton icon={AppIcons.more} label="More" />
          <Button>Next</Button>
        </DesignSystemProvider>,
      );
      await user.tab();
      expect(await screen.findByRole('tooltip')).toBeInTheDocument();
      keepClosingLayersOnScreen();

      await user.tab();
      expect(fadingTooltip()).not.toBeNull();
      expect(listeners.count()).toBe(1);

      endFade();
      expect(fadingTooltip()).toBeNull();
      expect(listeners.count()).toBe(0);
      listeners.restore();
    });
  });

  it('focus handed back by code shows no tooltip after a pointer choice, and shows it after a key press', async () => {
    const user = userEvent.setup();
    render(
      <DesignSystemProvider>
        <Menu trigger={<IconButton icon={AppIcons.more} label="More" />}>
          <MenuItem>Edit</MenuItem>
        </Menu>
      </DesignSystemProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'More' });

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('More');
  });
});
