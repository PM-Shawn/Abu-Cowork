// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Dialog } from './dialog';
import { FullscreenSurface } from './fullscreen';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';

// happy-dom does not implement the pointer-capture and scrolling calls Radix menus make while opening.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);
// The surface's own element: the parent of the content given to it.
const surfaceOf = (content: HTMLElement) => content.parentElement as HTMLElement;
const escape = () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); };
// What a layer does once it has left the page runs one timer tick later.
const settle = () => { act(() => { vi.runOnlyPendingTimers(); }); };
// A press from the keyboard: the button has the focus, as it has after a real press.
const press = (name: string) => {
  const button = screen.getByRole('button', { name });
  act(() => { button.focus(); });
  fireEvent.click(button);
};
const enterFullscreen = () => press('Enter fullscreen');
// Radix opens a menu on Enter and puts the focus in it one frame later.
const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'More' });
  act(() => { trigger.focus(); });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  settle();
};

interface StageProps {
  open: boolean;
  layer?: boolean;
  scrim?: boolean;
  onExit?: () => void;
  onModalChange?: (open: boolean) => void;
  initialFocus?: (surface: HTMLElement) => HTMLElement | null;
  dialog?: boolean;
  onDialogChange?: (open: boolean) => void;
  children?: ReactNode;
}

// A page with a control outside the surface, the surface, and a dialog that can open over it.
function Stage({ open, layer = false, scrim = false, onExit = () => undefined, onModalChange, initialFocus, dialog = false, onDialogChange, children }: StageProps) {
  return (
    <DesignSystemProvider onModalChange={onModalChange}>
      <Button>Outside</Button>
      <FullscreenSurface
        open={open}
        onExit={onExit}
        label="Weather app"
        layer={layer}
        scrim={scrim}
        scrimProps={{ 'data-testid': 'backdrop' }}
        initialFocus={initialFocus}
        className="bg-surface"
        style={{ top: 32 }}
      >
        <div data-testid="content">
          {children ?? (
            <>
              <Button>First</Button>
              <Button data-exit="">Exit</Button>
            </>
          )}
        </div>
      </FullscreenSurface>
      <Dialog open={dialog} onOpenChange={onDialogChange} title="Settings"><Button>Save</Button></Dialog>
    </DesignSystemProvider>
  );
}

// Owns the open state, as the app does: onExit closes the surface.
function Owned({ onExit, ...props }: Omit<StageProps, 'open'> & { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Enter fullscreen</Button>
      <Stage {...props} open={open} onExit={() => { onExit?.(); setOpen(false); }} />
    </>
  );
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('FullscreenSurface, closed', () => {
  it.each([[false], [true]])('renders its content with no surface around it (layer: %s)', (layer) => {
    render(<Stage open={false} layer={layer} scrim />);
    const surface = surfaceOf(screen.getByTestId('content'));
    expect(surface.tagName).toBe('DIV');
    // The element makes no box of its own: the content lays out as if it were not there.
    expect(classes(surface)).toEqual(['contents']);
    expect(surface).not.toHaveAttribute('data-electron-no-drag');
    expect(surface).not.toHaveAttribute('data-ds-layer');
    expect(surface).not.toHaveAttribute('role');
    expect(surface).not.toHaveAttribute('aria-label');
    expect(surface).not.toHaveAttribute('style');
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument();
  });

  // A focus scope that is mounted takes the keyboard trap from the dialog that is open. A closed
  // surface (an app block that arrives in the chat behind a dialog) must leave that dialog alone.
  it('leaves the focus trap of an open dialog alone when it joins the page', () => {
    function Page({ app }: { app: boolean }) {
      return (
        <DesignSystemProvider>
          <Button>Outside</Button>
          <Dialog open title="Settings"><Button>Save</Button></Dialog>
          {app && (
            <FullscreenSurface open={false} onExit={() => undefined} label="Weather app" layer>
              <Button>In the app</Button>
            </FullscreenSurface>
          )}
        </DesignSystemProvider>
      );
    }
    const view = render(<Page app={false} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveFocus();
    view.rerender(<Page app />);
    settle();
    expect(save).toHaveFocus();
    // Focus that tries to leave the dialog is pulled back into it.
    act(() => { screen.getByText('Outside').focus(); });
    expect(save).toHaveFocus();
  });
});

describe('FullscreenSurface, open in place (not a layer)', () => {
  it('covers the window on its own level, off the drag lanes, and is no layer', () => {
    const onModalChange = vi.fn();
    render(<Stage open onModalChange={onModalChange} />);
    const surface = surfaceOf(screen.getByTestId('content'));
    expect(surface).toHaveAttribute('data-electron-no-drag');
    expect(classes(surface)).toContain('fixed');
    expect(classes(surface)).toContain('inset-0');
    // Above what the page pins (the window's title-bar controls), under every floating level.
    expect(classes(surface)).toContain('z-fullscreen');
    expect(classes(surface)).not.toContain('z-sticky');
    expect(classes(surface)).not.toContain('z-popover');
    expect(classes(surface)).not.toContain('z-dialog');
    expect(classes(surface)).toContain('bg-surface');
    expect(surface.style.top).toBe('32px');
    expect(surface).not.toHaveAttribute('data-ds-layer');
    expect(surface).not.toHaveAttribute('aria-modal');
    expect(surface).toHaveAttribute('role', 'group');
    expect(surface).toHaveAttribute('aria-label', 'Weather app');
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(onModalChange).not.toHaveBeenCalled();
  });

  it('never has a backdrop, also when asked for one', () => {
    render(<Stage open scrim />);
    expect(screen.queryByTestId('backdrop')).toBeNull();
  });

  it('leaves the focus where it is when it opens and when it closes', () => {
    const view = render(<Stage open={false} />);
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => { outside.focus(); });
    view.rerender(<Stage open />);
    settle();
    expect(outside).toHaveFocus();
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { exit.focus(); });
    view.rerender(<Stage open={false} />);
    settle();
    expect(exit).toHaveFocus();
  });

  // The page under the surface cannot be seen: Tab never walks onto it, where Enter would act
  // on a control the user does not see.
  it('keeps Tab inside, going round from the last control to the first and back', () => {
    render(<Stage open />);
    const first = screen.getByRole('button', { name: 'First' });
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { exit.focus(); });
    // fireEvent returns false when the key was used (default prevented).
    expect(fireEvent.keyDown(exit, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(exit).toHaveFocus();
  });

  it('leaves Tab between its own controls to the browser', () => {
    render(
      <Stage open>
        <Button>First</Button>
        <Button>Middle</Button>
        <Button>Exit</Button>
      </Stage>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const middle = screen.getByRole('button', { name: 'Middle' });
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { first.focus(); });
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true);
    act(() => { middle.focus(); });
    expect(fireEvent.keyDown(middle, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(middle, { key: 'Tab', shiftKey: true })).toBe(true);
    act(() => { exit.focus(); });
    expect(fireEvent.keyDown(exit, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(exit).toHaveFocus();
  });

  it('brings the focus in when Tab is pressed on the page it covers', () => {
    render(<Stage open />);
    const outside = screen.getByRole('button', { name: 'Outside' });
    const first = screen.getByRole('button', { name: 'First' });
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { outside.focus(); });
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
    act(() => { outside.focus(); });
    expect(fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(exit).toHaveFocus();
    // The focus is on the window itself.
    act(() => { exit.blur(); });
    expect(document.body).toHaveFocus();
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
  });

  it('uses the key and moves nothing when it holds no control', () => {
    render(<Stage open><span>Nothing to press</span></Stage>);
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => { outside.focus(); });
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(false);
    expect(outside).toHaveFocus();
  });

  // A frame that has the focus keeps every key, so Tab out of a frame at either end of the
  // surface is caught by a stop that turns the focus round.
  it('turns the focus round at a stop before and after its content', () => {
    render(<Stage open />);
    const surface = surfaceOf(screen.getByTestId('content'));
    const first = screen.getByRole('button', { name: 'First' });
    const exit = screen.getByRole('button', { name: 'Exit' });
    const stops = Array.from(surface.querySelectorAll<HTMLElement>('[data-ds-focus-guard]'));
    expect(stops).toHaveLength(2);
    expect(surface.firstElementChild).toBe(stops[0]);
    expect(surface.lastElementChild).toBe(stops[1]);
    expect(stops[0].tabIndex).toBe(0);
    expect(stops[1].tabIndex).toBe(0);
    act(() => { stops[1].focus(); });
    expect(first).toHaveFocus();
    act(() => { stops[0].focus(); });
    expect(exit).toHaveFocus();
    // The stops are not controls of the surface: the round skips them.
    expect(fireEvent.keyDown(exit, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
  });

  it.each([
    ['closed', { open: false }],
    ['a layer', { open: true, layer: true }],
  ])('has no such stops and holds no Tab of its own when it is %s', (_name, props) => {
    render(<Stage {...props} />);
    settle();
    const surface = surfaceOf(screen.getByTestId('content'));
    expect(surface.querySelector('[data-ds-focus-guard]')).toBeNull();
    const outside = screen.getByRole('button', { name: 'Outside' });
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true);
  });

  it('leaves Tab inside a menu opened over it to the menu', () => {
    render(
      <Stage open>
        <Button>First</Button>
        <Menu trigger={<Button>More</Button>}><MenuItem>Reload</MenuItem></Menu>
      </Stage>,
    );
    openMenu();
    const menu = screen.getByRole('menu');
    const inMenu = document.activeElement as HTMLElement;
    expect(menu).toContainElement(inMenu);
    fireEvent.keyDown(inMenu, { key: 'Tab' });
    expect(inMenu).toHaveFocus();
    expect(screen.getByRole('button', { name: 'First', hidden: true })).not.toHaveFocus();
  });

  // The layer's box is portaled out of the surface: a Tab between two of its controls is the
  // browser's, and the surface does not take it for a Tab pressed on the covered page.
  it('leaves Tab inside a popover opened over it to the popover', () => {
    render(
      <Stage open>
        <Button>First</Button>
        <Popover trigger={<Button>Filters</Button>} label="Filters">
          <Button>Newest</Button>
          <Button>Oldest</Button>
        </Popover>
      </Stage>,
    );
    press('Filters');
    settle();
    const newest = screen.getByRole('button', { name: 'Newest' });
    expect(screen.getByRole('dialog', { name: 'Filters' })).toHaveAttribute('data-ds-layer');
    act(() => { newest.focus(); });
    expect(fireEvent.keyDown(newest, { key: 'Tab' })).toBe(true);
    expect(newest).toHaveFocus();
  });

  // After a press on an approval's scrim the focus is on the window. The next Tab is the
  // approval's to bring back: the surface under it must not take the focus for a control there.
  it('leaves Tab to a window or an approval that is open over it, wherever the focus is', () => {
    render(
      <DesignSystemProvider>
        <FullscreenSurface open onExit={() => undefined} label="Notes">
          <div data-testid="content"><Button>First</Button></div>
        </FullscreenSurface>
        <Dialog open layer="approval" role="alertdialog" outsidePress="ignore" title="Run this command?" footer={<Button>Cancel</Button>} />
      </DesignSystemProvider>,
    );
    settle();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    expect(document.body).toHaveFocus();

    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(true);

    expect(screen.getByRole('button', { name: 'First', hidden: true })).not.toHaveFocus();
  });

  // A preview tab that is fullscreen stays so when another tab takes its place: its panel is
  // hidden with the surface in it, and Tab belongs to the page again.
  it.each([
    ['the hidden attribute', { hidden: true }],
    ['display: none', { style: { display: 'none' } }],
  ])('holds no Tab while an element around it is taken off the page with %s', (_name, wrapperProps) => {
    render(
      <DesignSystemProvider>
        <Button>Outside</Button>
        <div {...wrapperProps}>
          <FullscreenSurface open onExit={() => undefined} label="Notes">
            <div data-testid="content"><Button>First</Button></div>
          </FullscreenSurface>
        </div>
      </DesignSystemProvider>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => { outside.focus(); });

    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true);
    expect(outside).toHaveFocus();
    act(() => { outside.blur(); });
    expect(fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(document.body).toHaveFocus();
  });

  it('leaves a Tab that another handler has used alone', () => {
    render(<Stage open />);
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { exit.focus(); });
    const used = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', used, true);
    try {
      fireEvent.keyDown(exit, { key: 'Tab' });
    } finally {
      document.removeEventListener('keydown', used, true);
    }
    expect(exit).toHaveFocus();
  });

  it('holds Tab only while it is open', () => {
    const view = render(<Stage open />);
    const exit = screen.getByRole('button', { name: 'Exit' });
    act(() => { exit.focus(); });
    view.rerender(<Stage open={false} />);
    expect(fireEvent.keyDown(exit, { key: 'Tab' })).toBe(true);
    expect(exit).toHaveFocus();
  });

  it('leaves on Escape, and listens only while it is open', () => {
    const onExit = vi.fn();
    const view = render(<Stage open={false} onExit={onExit} />);
    escape();
    expect(onExit).not.toHaveBeenCalled();
    view.rerender(<Stage open onExit={onExit} />);
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
    view.rerender(<Stage open={false} onExit={onExit} />);
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape pressed inside a menu to the menu', () => {
    const onExit = vi.fn();
    render(
      <Stage open onExit={onExit}>
        <Menu trigger={<Button>More</Button>}><MenuItem>Reload</MenuItem></Menu>
      </Stage>,
    );
    openMenu();
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-ds-layer');
    // The menu is a layer of the page above the surface.
    expect(classes(menu)).toContain('z-popover');
    expect(menu).toContainElement(document.activeElement as HTMLElement);
    escape();
    settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // The focus is on the page body (after a press on a scrim): the key is pressed outside every
  // layer, and the window on top uses it. One press, one thing closed.
  it('stays when the Escape closed a window that is open over it', () => {
    const onExit = vi.fn();
    const onDialogChange = vi.fn();
    render(<Stage open onExit={onExit} dialog onDialogChange={onDialogChange} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onDialogChange.mock.calls).toEqual([[false]]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('stays when the Escape refused an approval that shows over it', () => {
    const onExit = vi.fn();
    const answers: boolean[] = [];
    render(
      <DesignSystemProvider>
        <FullscreenSurface open onExit={onExit} label="Notes">
          <div data-testid="content"><Button>First</Button></div>
        </FullscreenSurface>
        <Dialog open onOpenChange={(open) => answers.push(open)} layer="approval" role="alertdialog" outsidePress="ignore" title="Run this command?" footer={<Button>Cancel</Button>} />
      </DesignSystemProvider>,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(answers).toEqual([false]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('stays when another handler has used the Escape', () => {
    const onExit = vi.fn();
    render(<Stage open onExit={onExit} />);
    const used = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', used, true);
    try {
      escape();
    } finally {
      document.removeEventListener('keydown', used, true);
    }
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('FullscreenSurface as a layer', () => {
  it('is a named modal dialog on the dialog level, with the backdrop before it', () => {
    const onModalChange = vi.fn();
    render(<Stage open layer scrim onModalChange={onModalChange} />);
    const surface = surfaceOf(screen.getByTestId('content'));
    expect(screen.getByRole('dialog', { name: 'Weather app' })).toBe(surface);
    expect(surface).toHaveAttribute('data-ds-layer');
    expect(surface).toHaveAttribute('data-state', 'open');
    expect(surface).toHaveAttribute('aria-modal', 'true');
    expect(surface).toHaveAttribute('data-electron-no-drag');
    expect(classes(surface)).toContain('fixed');
    expect(classes(surface)).toContain('inset-0');
    expect(classes(surface)).toContain('z-dialog');
    expect(classes(surface)).not.toContain('z-sticky');
    expect(classes(surface)).toContain('bg-surface');
    const backdrop = screen.getByTestId('backdrop');
    expect(surface.previousElementSibling).toBe(backdrop);
    expect(classes(backdrop)).toContain('bg-scrim');
    expect(classes(backdrop)).toContain('fixed');
    expect(classes(backdrop)).toContain('inset-0');
    expect(classes(backdrop)).toContain('z-dialog');
    expect(backdrop).toHaveAttribute('data-electron-no-drag');
    // The app hides what the page cannot paint over while a layer is open.
    expect(onModalChange.mock.calls).toEqual([[true]]);
  });

  it('has no backdrop unless it is asked for one', () => {
    render(<Stage open layer />);
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(surfaceOf(screen.getByTestId('content'))).toHaveAttribute('data-ds-layer');
  });

  // The surface covers the whole window, its scrim included. happy-dom cannot say which element
  // a press at a point reaches, so this pins what decides it in a browser: the surface's own box
  // takes no pointer input, its content does, and the press handler is on the scrim alone.
  it('lets a press beside its content through to the scrim, which leaves', () => {
    const onExit = vi.fn();
    render(<Stage open layer scrim onExit={onExit} />);
    const content = screen.getByTestId('content');
    const surface = surfaceOf(content);
    const backdrop = screen.getByTestId('backdrop');
    expect(classes(surface)).toContain('pointer-events-none');
    expect(classes(surface)).toContain('*:pointer-events-auto');
    expect(content.parentElement).toBe(surface);
    expect(classes(backdrop)).not.toContain('pointer-events-none');

    // A press that lands on the content, or on the surface's element itself, is no press on the scrim.
    fireEvent.click(content);
    fireEvent.click(surface);
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('keeps taking pointer input on its whole box when it has no scrim, and in the plain form', () => {
    const view = render(<Stage open layer />);
    expect(classes(surfaceOf(screen.getByTestId('content')))).not.toContain('pointer-events-none');
    view.unmount();
    render(<Stage open scrim />);
    expect(classes(surfaceOf(screen.getByTestId('content')))).not.toContain('pointer-events-none');
  });

  it('opens on the control initialFocus names, and never inside a frame', () => {
    const view = render(
      <Stage open={false} layer initialFocus={(surface) => surface.querySelector<HTMLElement>('[data-exit]')}>
        <iframe title="App" />
        <Button>First</Button>
        <Button data-exit="">Exit</Button>
      </Stage>,
    );
    act(() => { screen.getByRole('button', { name: 'Outside' }).focus(); });
    view.rerender(
      <Stage open layer initialFocus={(surface) => surface.querySelector<HTMLElement>('[data-exit]')}>
        <iframe title="App" />
        <Button>First</Button>
        <Button data-exit="">Exit</Button>
      </Stage>,
    );
    expect(screen.getByRole('button', { name: 'Exit' })).toHaveFocus();
    expect(document.activeElement?.tagName).not.toBe('IFRAME');
  });

  it('moves the focus out of a frame that had it when it opened', () => {
    const page = (open: boolean) => (
      <Stage open={open} layer initialFocus={(surface) => surface.querySelector<HTMLElement>('[data-exit]')}>
        <iframe title="App" tabIndex={0} />
        <Button data-exit="">Exit</Button>
      </Stage>
    );
    const view = render(page(false));
    const frame = screen.getByTitle('App');
    act(() => { frame.focus(); });
    expect(frame).toHaveFocus();
    view.rerender(page(true));
    expect(screen.getByRole('button', { name: 'Exit' })).toHaveFocus();
  });

  it('opens on its first control when no control is named, passing over a frame', () => {
    const page = (open: boolean) => (
      <Stage open={open} layer>
        <iframe title="App" tabIndex={0} />
        <Button>First</Button>
        <Button>Exit</Button>
      </Stage>
    );
    const view = render(page(false));
    view.rerender(page(true));
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('opens with the focus on its own box when it holds no control', () => {
    const page = (open: boolean) => <Stage open={open} layer><p>Nothing to press</p></Stage>;
    const view = render(page(false));
    view.rerender(page(true));
    expect(surfaceOf(screen.getByTestId('content'))).toHaveFocus();
  });

  it('keeps Tab inside, going round from the last control to the first and back', () => {
    render(<Owned layer scrim />);
    enterFullscreen();
    const first = screen.getByRole('button', { name: 'First' });
    const exit = screen.getByRole('button', { name: 'Exit' });
    expect(first).toHaveFocus();
    // Shift+Tab on the first control goes to the last, Tab on the last to the first. Between
    // them the browser moves the focus itself.
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(exit).toHaveFocus();
    expect(fireEvent.keyDown(exit, { key: 'Tab' })).toBe(false);
    expect(first).toHaveFocus();
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true);
    // Focus that code sends outside comes back in.
    act(() => { screen.getByRole('button', { name: 'Outside' }).focus(); });
    expect(first).toHaveFocus();
  });

  it('gives the focus back to the control that had it before, once it has closed', () => {
    const onModalChange = vi.fn();
    render(<Owned layer scrim onModalChange={onModalChange} />);
    const opener = screen.getByRole('button', { name: 'Enter fullscreen' });
    enterFullscreen();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    fireEvent.click(screen.getByTestId('backdrop'));
    settle();
    expect(opener).toHaveFocus();
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(classes(surfaceOf(screen.getByTestId('content')))).toEqual(['contents']);
    // It has no fade: the app hears that it has left as soon as it has, not one fade later.
    expect(onModalChange.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves on Escape once, through the layer manager', () => {
    const onExit = vi.fn();
    render(<Owned layer scrim onExit={onExit} />);
    enterFullscreen();
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
    settle();
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('leaves an Escape that another handler has used alone', () => {
    const onExit = vi.fn();
    render(<Owned layer scrim onExit={onExit} />);
    enterFullscreen();
    const used = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', used, true);
    try {
      escape();
    } finally {
      document.removeEventListener('keydown', used, true);
    }
    expect(onExit).not.toHaveBeenCalled();
  });

  it('leaves an Escape pressed inside a menu to the menu, which sits on the dialog level', () => {
    const onExit = vi.fn();
    render(
      <Owned layer scrim onExit={onExit}>
        <Menu trigger={<Button>More</Button>}><MenuItem>Reload</MenuItem></Menu>
      </Owned>,
    );
    enterFullscreen();
    openMenu();
    const menu = screen.getByRole('menu');
    expect(classes(menu)).toContain('z-dialog');
    expect(menu).toContainElement(document.activeElement as HTMLElement);
    // The menu is a layer opened inside the surface: the surface stays.
    expect(surfaceOf(screen.getByTestId('content'))).toHaveAttribute('data-ds-layer');
    escape();
    settle();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
    // The focus is back on the menu's button, inside the surface.
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    escape();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('is replaced by a dialog that opens: it is told to leave, and the focus stays in the dialog', () => {
    const onExit = vi.fn();
    function Page({ dialog }: { dialog: boolean }) {
      const [open, setOpen] = useState(true);
      return <Stage open={open} layer scrim dialog={dialog} onExit={() => { onExit(); setOpen(false); }} />;
    }
    const view = render(<Page dialog={false} />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    view.rerender(<Page dialog />);
    expect(onExit).toHaveBeenCalledTimes(1);
    settle();
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
  });

  it('is turned away while an approval is on the page: told to leave, and never shown', () => {
    const onExit = vi.fn();
    const seen: boolean[] = [];
    function Page({ open }: { open: boolean }) {
      return (
        <DesignSystemProvider>
          <Dialog open layer="approval" role="alertdialog" title="Run this command?" footer={<Button>Cancel</Button>} />
          <FullscreenSurface open={open} onExit={onExit} label="Weather app" layer scrim scrimProps={{ 'data-testid': 'backdrop' }}>
            <div data-testid="content"><Button>First</Button></div>
          </FullscreenSurface>
        </DesignSystemProvider>
      );
    }
    const view = render(<Page open={false} />);
    const observer = new MutationObserver(() => {
      seen.push(surfaceOf(screen.getByTestId('content')).hasAttribute('data-ds-layer') || screen.queryByTestId('backdrop') !== null);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    view.rerender(<Page open />);
    observer.takeRecords();
    observer.disconnect();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(surfaceOf(screen.getByTestId('content'))).not.toHaveAttribute('data-ds-layer');
    expect(screen.queryByTestId('backdrop')).toBeNull();
    expect(seen).not.toContain(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('tells the app it has left when it leaves the page while open', () => {
    const onModalChange = vi.fn();
    function Page({ mounted }: { mounted: boolean }) {
      return (
        <DesignSystemProvider onModalChange={onModalChange}>
          {mounted && <FullscreenSurface open onExit={() => undefined} label="Weather app" layer><Button>First</Button></FullscreenSurface>}
        </DesignSystemProvider>
      );
    }
    const view = render(<Page mounted />);
    expect(onModalChange.mock.calls).toEqual([[true]]);
    view.rerender(<Page mounted={false} />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(onModalChange.mock.calls).toEqual([[true], [false]]);
  });
});

describe('FullscreenSurface and what is inside it', () => {
  // A live iframe reloads when its element is rebuilt, so the content is never taken out of the tree.
  it.each([[false], [true]])('keeps the very same content nodes when it opens and closes (layer: %s)', (layer) => {
    const page = (open: boolean) => (
      <Stage open={open} layer={layer} scrim>
        <iframe title="App" />
        <Button>Exit</Button>
      </Stage>
    );
    const view = render(page(false));
    const content = screen.getByTestId('content');
    const frame = screen.getByTitle('App');
    const surface = surfaceOf(content);
    view.rerender(page(true));
    settle();
    expect(screen.getByTestId('content')).toBe(content);
    expect(screen.getByTitle('App')).toBe(frame);
    expect(surfaceOf(content)).toBe(surface);
    expect(classes(surface)).toContain('fixed');
    view.rerender(page(false));
    settle();
    expect(screen.getByTestId('content')).toBe(content);
    expect(screen.getByTitle('App')).toBe(frame);
    expect(surfaceOf(content)).toBe(surface);
    expect(classes(surface)).toEqual(['contents']);
  });
});
