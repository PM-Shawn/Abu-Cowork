// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { pointerTargetOf } from '@/test/pointerTarget';
import { Button, IconButton } from './button';
import { Dialog } from './dialog';
import { AppIcons } from './icons';
import { DesignSystemProvider } from './provider';

// The two ds buttons, busy, as the cases below place them: inside a card that opens on click and
// in the footer of a window.
const BUSY_BUTTONS: [string, (onClick: () => void) => ReactElement, () => HTMLElement][] = [
  ['Button', (onClick) => <Button busy onClick={onClick}>Install</Button>, () => screen.getByRole('button', { name: 'Install' })],
  ['IconButton', (onClick) => <IconButton busy icon={AppIcons.reload} label="Reload" onClick={onClick} />, () => screen.getByRole('button', { name: 'Reload' })],
];

describe('Button', () => {
  it('is a plain button by default and runs its handler', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each([
    ['primary', 'bg-emphasis'],
    ['secondary', 'bg-fill'],
    ['plain', 'not-aria-disabled:hover:bg-fill-hover'],
    ['danger', 'text-danger'],
  ] as const)('styles the %s variant', (variant, token) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(token);
  });

  // A busy button keeps its resting look under the pointer: every fill that answers the pointer
  // is switched off while the button is aria-disabled.
  it.each([
    ['primary', 'not-aria-disabled:hover:opacity-90', 'not-aria-disabled:active:opacity-80'],
    ['secondary', 'not-aria-disabled:hover:bg-fill-selected', 'not-aria-disabled:active:bg-fill-pressed'],
    ['plain', 'not-aria-disabled:hover:bg-fill-hover', 'not-aria-disabled:active:bg-fill-pressed'],
    ['danger', 'not-aria-disabled:hover:bg-fill-selected', 'not-aria-disabled:active:bg-fill-pressed'],
  ] as const)('answers the pointer in the %s variant only while it is not busy', (variant, hover, pressed) => {
    render(<Button variant={variant}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button).toHaveClass(hover);
    expect(button).toHaveClass(pressed);
    const answersAlways = button.className.split(/\s+/).filter((name) => /^(hover|active):/.test(name));
    expect(answersAlways).toEqual([]);
  });

  it('uses the two control heights', () => {
    render(<><Button size="sm">Small</Button><Button>Regular</Button></>);
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('h-6');
    expect(screen.getByRole('button', { name: 'Regular' })).toHaveClass('h-7');
  });

  it('cannot be clicked while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Send</Button>);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  // A button that is working keeps the keyboard where it is: it stays focusable and takes no press.
  it('keeps focus and takes no press while busy', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Check</Button>);
    const button = screen.getByRole('button', { name: 'Check' });
    await user.tab();
    expect(button).toHaveFocus();

    rerender(<Button busy onClick={onClick}>Check</Button>);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('disabled');
    expect(button).not.toHaveAttribute('busy');
    expect(button).toHaveClass('aria-disabled:opacity-40');
    // The pointer still lands on it (a press must not reach what is behind), with a plain cursor.
    expect(button).not.toHaveClass('aria-disabled:pointer-events-none');
    expect(button).toHaveClass('aria-disabled:cursor-default');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button onClick={onClick}>Check</Button>);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('submits no form while busy', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit" busy>Send</Button></form>);
    screen.getByRole('button', { name: 'Send' }).focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('is named by its label and shows the same label as a tooltip on focus', async () => {
    const user = userEvent.setup();
    render(<IconButton icon={AppIcons.copy} label="Copy code" />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Copy code' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Copy code');
  });

  it('opens its tooltip above by default and on the side it is given', async () => {
    const user = userEvent.setup();
    render(
      <>
        <IconButton icon={AppIcons.copy} label="Copy code" />
        <IconButton icon={AppIcons.reload} label="Reload" tooltipSide="bottom" />
      </>,
      { wrapper: DesignSystemProvider },
    );
    await user.tab();
    expect((await screen.findByRole('tooltip')).closest('[data-side]')).toHaveAttribute('data-side', 'top');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveFocus();
    await screen.findByText('Reload', { selector: '[role="tooltip"]' });
    expect(screen.getByRole('tooltip').closest('[data-side]')).toHaveAttribute('data-side', 'bottom');
    expect(screen.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('tooltipside');
  });

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render(<IconButton icon={AppIcons.copy} label="Copy" />)).toThrow(/DesignSystemProvider/);
  });

  it('renders the primary icon button filled with the emphasis color', () => {
    render(<IconButton icon={AppIcons.add} label="Send" variant="primary" />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveClass('bg-emphasis', 'text-on-emphasis');
    // One class per assertion: not.toHaveClass with several names passes when any one is missing.
    expect(button).not.toHaveClass('text-label-secondary');
    expect(button).not.toHaveClass('not-aria-disabled:hover:text-label');
    expect(button).toHaveClass('not-aria-disabled:hover:text-on-emphasis');
  });

  it.each([
    ['plain', 'not-aria-disabled:hover:bg-fill-hover', 'not-aria-disabled:active:bg-fill-pressed'],
    ['secondary', 'not-aria-disabled:hover:bg-fill-selected', 'not-aria-disabled:active:bg-fill-pressed'],
    ['primary', 'not-aria-disabled:hover:opacity-90', 'not-aria-disabled:active:opacity-80'],
  ] as const)('answers the pointer in the %s variant only while it is not busy', (variant, hover, pressed) => {
    render(<IconButton icon={AppIcons.copy} label="Copy code" variant={variant} aria-pressed />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Copy code' });
    expect(button).toHaveClass(hover);
    expect(button).toHaveClass(pressed);
    // Also the fills of a pressed toggle, and the text color under the pointer.
    const answersAlways = button.className.split(/\s+/).filter((name) => /(^|:)(hover|active):/.test(name) && !name.includes('not-aria-disabled:'));
    expect(answersAlways).toEqual([]);
  });

  // An icon button whose own action is running keeps the keyboard where it is, like Button busy.
  it('keeps focus and its name and takes no press while busy', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<IconButton icon={AppIcons.reload} label="Reload" onClick={onClick} />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Reload' });
    await user.tab();
    expect(button).toHaveFocus();

    rerender(<IconButton icon={AppIcons.reload} label="Reload" busy onClick={onClick} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBe(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('disabled');
    expect(button).not.toHaveAttribute('busy');
    expect(button).toHaveClass('aria-disabled:opacity-40');
    expect(button).not.toHaveClass('aria-disabled:pointer-events-none');
    expect(button).toHaveClass('aria-disabled:cursor-default');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<IconButton icon={AppIcons.reload} label="Reload" onClick={onClick} />);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  // A pressed toggle keeps its selected fill while the pointer rests on it; callers only set aria-pressed.
  it('gives a pressed toggle its own fill, text color, hover and press-down classes', () => {
    render(<IconButton icon={AppIcons.preview} label="Preview" aria-pressed />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Preview' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('aria-pressed:bg-fill-selected');
    expect(button).toHaveClass('aria-pressed:text-label');
    expect(button).toHaveClass('aria-pressed:not-aria-disabled:hover:bg-fill-selected');
    expect(button).toHaveClass('aria-pressed:not-aria-disabled:active:bg-fill-pressed');
  });

  // A mark that shows its state in the icon itself (a filled star) is still a toggle, without the fill.
  it('lets a pressed toggle opt out of the pressed fill and keeps aria-pressed', () => {
    render(<IconButton icon={AppIcons.favorite} label="Favorite" aria-pressed pressedFill={false} />, { wrapper: DesignSystemProvider });
    const button = screen.getByRole('button', { name: 'Favorite' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).not.toHaveAttribute('pressedfill');
    expect(button).not.toHaveClass('aria-pressed:bg-fill-selected');
    expect(button).not.toHaveClass('aria-pressed:text-label');
    expect(button).not.toHaveClass('aria-pressed:not-aria-disabled:hover:bg-fill-selected');
    expect(button).not.toHaveClass('aria-pressed:not-aria-disabled:active:bg-fill-pressed');
    // It stays an ordinary plain button under the pointer.
    expect(button).toHaveClass('not-aria-disabled:hover:bg-fill-hover');
    expect(button).toHaveClass('text-label-secondary');
  });
});

// A busy button takes the press itself and does nothing with it: no action, nothing for what is
// behind it, and the focus stays on it. `pointerTargetOf` gives the element the pointer lands on.
describe.each(BUSY_BUTTONS)('a busy %s', (_name, ui, find) => {
  it('keeps a pointer press from the card behind it, and keeps the focus', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onCardClick = vi.fn();
    render(<div role="button" tabIndex={0} aria-label="Card" onClick={onCardClick}>{ui(onClick)}</div>, { wrapper: DesignSystemProvider });
    const button = find();
    button.focus();

    await user.click(pointerTargetOf(button));

    expect(onCardClick).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button.tabIndex).toBe(0);
  });

  it('takes the press when the focus was elsewhere, and still starts nothing', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onCardClick = vi.fn();
    render(<div role="button" tabIndex={0} aria-label="Card" onClick={onCardClick}>{ui(onClick)}</div>, { wrapper: DesignSystemProvider });
    const card = screen.getByRole('button', { name: 'Card' });
    card.focus();

    await user.dblClick(pointerTargetOf(find()));

    expect(onCardClick).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(card).not.toHaveFocus();
  });

  it('keeps Enter, Space and a click that no pointer made from the card behind it', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onCardClick = vi.fn();
    render(<div role="button" tabIndex={0} aria-label="Card" onClick={onCardClick}>{ui(onClick)}</div>, { wrapper: DesignSystemProvider });
    const button = find();
    button.focus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    // fireEvent.click reports `detail` 0: assistive technology, or a click made by code.
    const notPrevented = fireEvent.click(button);

    expect(onCardClick).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
    expect(button).toHaveFocus();
  });

  it('leaves the focus where it was when it is pressed in the footer of a window', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Add a connector" footer={ui(onClick)}>
        <p>Body</p>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const button = find();
    button.focus();
    expect(button).toHaveFocus();

    await user.click(pointerTargetOf(button));

    expect(button).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Add a connector' })).not.toHaveFocus();
    expect(onClick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

});

// Only a busy button keeps its click to itself: what a working handler lets through to the
// elements around the button stays the caller's business.
it('a button that is not busy runs its handler and lets the click go on', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const onCardClick = vi.fn();
  render(<div role="button" tabIndex={0} aria-label="Card" onClick={onCardClick}><Button onClick={onClick}>Install</Button></div>);

  await user.click(screen.getByRole('button', { name: 'Install' }));

  expect(onClick).toHaveBeenCalledOnce();
  expect(onCardClick).toHaveBeenCalledOnce();
});
